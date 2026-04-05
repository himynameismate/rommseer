import { prisma } from "@/lib/db";
import { logger } from "@/lib/utils";
import { getCachedSABnzbdClient, getCachedQBittorrentClient, getCachedRomMClient, debouncedScan } from "@/lib/clients";
import { recordIndexerFailure } from "@/lib/autograb";
import { formatBytes } from "@/lib/utils";
import { logActivity, notify } from "@/lib/notifications";
import { ROM_EXTENSIONS } from "@/lib/constants";
import { getValidExtensionsForPlatform, hasPlatformMismatch } from "@/lib/prowlarr";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

/**
 * Check if `child` is a subpath of `parent` (safe against symlinks and Unicode tricks).
 * Uses path.relative() instead of string prefix matching.
 */
function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * After a download completes, copy the ROM file(s) to RomM's library directory.
 * Source path comes from SABnzbd (storage) or qBittorrent (content_path).
 * Destination: <rommLibraryPath>/<platformSlug>/
 *
 * @returns true if files were copied, false if skipped/failed
 */
export async function copyToRomMLibrary(
  requestId: number,
  downloadId: number
): Promise<boolean> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.rommLibraryPath) {
    logger.log(`[PostCopy] No RomM library path configured, skipping copy — marking AVAILABLE directly`);
    await prisma.request.update({ where: { id: requestId }, data: { status: "AVAILABLE" } });
    return true; // treat as "copied" so copyAndScan triggers the scan
  }

  const download = await prisma.download.findUnique({
    where: { id: downloadId },
    include: {
      request: {
        include: { game: { include: { platform: true } } },
      },
    },
  });

  if (!download) {
    logger.error(`[PostCopy] Download #${downloadId} not found`);
    return false;
  }

  // Get the source path from the download client
  const sourcePath = await getSourcePath(download);
  if (!sourcePath) {
    logger.log(`[PostCopy] Could not determine source path for download #${downloadId}`);
    return false;
  }

  // Determine platform slug for destination folder
  const platformSlug = await getPlatformSlug(download.request.game.platform);
  if (!platformSlug) {
    logger.error(`[PostCopy] Could not determine platform slug for "${download.request.game.platform.name}"`);
    return false;
  }

  // Sanitize platformSlug to only allow safe characters
  if (!/^[a-zA-Z0-9_-]+$/.test(platformSlug)) {
    logger.error(`[PostCopy] Invalid platform slug: "${platformSlug}"`);
    return false;
  }

  // ROMs live in <library>/<platform>/roms/ — the "roms" subfolder is required by RomM
  const destDir = path.resolve(settings.rommLibraryPath, platformSlug, "roms");

  // Validate destDir is within the expected library path
  if (!isSubPath(path.resolve(settings.rommLibraryPath), destDir)) {
    logger.error(`[PostCopy] Path traversal detected: destDir "${destDir}" is outside library path "${settings.rommLibraryPath}"`);
    return false;
  }

  logger.log(`[PostCopy] Copying from "${sourcePath}" to "${destDir}" for request #${requestId}`);

  try {
    fs.mkdirSync(destDir, { recursive: true });

    // Collect ROM files from source
    const romFiles = findRomFiles(sourcePath);
    if (romFiles.length === 0) {
      logger.log(`[PostCopy] No ROM files found in "${sourcePath}"`);
      return false;
    }

    // Validate downloaded files match the requested platform
    const platformName = download.request.game.platform.name;
    const validExts = getValidExtensionsForPlatform(platformName);
    if (validExts) {
      const wrongFiles = romFiles.filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return !validExts.includes(ext) && ![".zip", ".7z", ".rar"].includes(ext);
      });

      if (wrongFiles.length > 0 && wrongFiles.length === romFiles.length) {
        const foundExts = wrongFiles.map((f) => path.extname(f).toLowerCase()).join(", ");
        const msg = `Wrong platform: downloaded files have extensions [${foundExts}] but expected [${validExts.join(", ")}] for "${platformName}"`;
        await rejectWrongPlatform(downloadId, requestId, msg, download, sourcePath);
        return false;
      }
    }

    // For archive-only downloads, validate the source folder/file name against the platform
    const allArchives = romFiles.every((f) => [".zip", ".7z", ".rar"].includes(path.extname(f).toLowerCase()));
    if (allArchives && romFiles.length > 0) {
      const sourceName = path.basename(sourcePath);
      if (hasPlatformMismatch(sourceName, platformName)) {
        const msg = `Wrong platform: archive "${sourceName}" appears to be for a different platform than "${platformName}"`;
        await rejectWrongPlatform(downloadId, requestId, msg, download, sourcePath);
        return false;
      }
    }

    const ARCHIVE_EXTS = new Set([".zip", ".7z", ".rar"]);
    let copied = 0;
    for (const srcFile of romFiles) {
      const filename = path.basename(srcFile);
      const ext = path.extname(filename).toLowerCase();

      if (ARCHIVE_EXTS.has(ext)) {
        // Extract archive directly into destDir, then delete the archive
        const extracted = extractArchiveToDir(srcFile, destDir);
        if (extracted > 0) {
          copied += extracted;
          logger.log(`[PostCopy] Extracted ${extracted} ROM(s) from "${filename}"`);
          // Delete source archive for direct (IA) downloads since the file is now extracted
          if (download.downloadType === "direct") {
            try { fs.unlinkSync(srcFile); } catch { /* ignore */ }
          }
        } else if (download.downloadType === "direct") {
          // For direct downloads, don't copy the archive — RomM can't use it
          logger.error(`[PostCopy] Extraction failed for "${filename}" (direct download), not copying archive`);
          try { fs.unlinkSync(srcFile); } catch { /* ignore */ }
        } else {
          // For torrent/usenet downloads, fall back to copying the archive as-is
          logger.log(`[PostCopy] Extraction failed for "${filename}", copying archive as fallback`);
          const destFile = path.resolve(destDir, filename);
          if (!isSubPath(destDir, destFile)) continue;
          fs.copyFileSync(srcFile, destFile);
          copied++;
        }
        continue;
      }

      const destFile = path.resolve(destDir, filename);

      // Validate destFile is within destDir to prevent path traversal via filename
      if (!isSubPath(destDir, destFile)) {
        logger.error(`[PostCopy] Skipping file with suspicious name: "${filename}"`);
        continue;
      }

      if (fs.existsSync(destFile)) {
        const srcStat = fs.statSync(srcFile);
        const destStat = fs.statSync(destFile);
        if (srcStat.size === destStat.size) {
          logger.log(`[PostCopy] "${filename}" already exists (same size), skipping`);
          continue;
        }
      }

      logger.log(`[PostCopy] Copying "${filename}" (${formatBytes(fs.statSync(srcFile).size)})`);
      fs.copyFileSync(srcFile, destFile);
      copied++;
    }

    logger.log(`[PostCopy] Done: ${copied} file(s) to ${destDir}`);
    return copied > 0;
  } catch (e) {
    logger.error(`[PostCopy] Failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Copy ROM files to RomM library and trigger a scan (non-blocking).
 * Shared by both requests/route.ts and downloads/route.ts.
 */
export function copyAndScan(requestId: number, downloadId: number): void {
  copyToRomMLibrary(requestId, downloadId)
    .then(async (copied) => {
      // Check if the download was marked FAILED (wrong platform detection)
      const dl = await prisma.download.findUnique({ where: { id: downloadId }, select: { status: true } });
      if (dl?.status === "FAILED") {
        logger.log(`[PostCopy] Download #${downloadId} was marked FAILED (wrong platform), sync loop will retry`);
        return;
      }

      if (!copied) {
        // Copy failed — mark the download FAILED and reset the request to APPROVED
        // so the admin can investigate and trigger a retry without re-downloading.
        logger.error(`[PostCopy] No files were copied for request #${requestId} — marking download FAILED, resetting request to APPROVED.`);
        await prisma.download.update({
          where: { id: downloadId },
          data: { status: "FAILED", error: "Post-copy failed: no files were copied to RomM library. Check library path and permissions." },
        });
        await prisma.request.update({ where: { id: requestId }, data: { status: "APPROVED" } });
        return;
      }

      // Files copied successfully — now mark the request AVAILABLE
      await prisma.request.update({ where: { id: requestId }, data: { status: "AVAILABLE" } });
      logger.log(`[PostCopy] Files copied for request #${requestId}, marked AVAILABLE, triggering RomM scan`);

      const req = await prisma.request.findUnique({
        where: { id: requestId },
        include: { game: { include: { platform: true } }, user: { select: { name: true } } },
      });
      if (!req) return;

      // Log activity + notify
      logActivity("AVAILABLE", `"${req.game.name}" is now available`, { requestId });
      notify({
        event: "AVAILABLE",
        gameName: req.game.name,
        platformName: req.game.platform.name,
        userName: req.user?.name || "System",
        coverUrl: req.game.coverUrl,
        userId: req.userId,
        requestId: requestId,
      });

      const romm = await getCachedRomMClient();
      if (!romm) return;

      try {
        const platforms = await romm.getPlatforms();
        const match = platforms.find((p) =>
          p.name.toLowerCase() === req.game.platform.name.toLowerCase() ||
          p.slug.toLowerCase() === req.game.platform.name.toLowerCase().replace(/\s+/g, "-")
        );

        if (match) {
          logger.log(`[RomM] Scanning platform "${match.name}" (id=${match.id}) for request #${requestId}`);
          debouncedScan(romm, match.id);
        } else {
          logger.log(`[RomM] No matching platform for "${req.game.platform.name}", triggering full scan`);
          debouncedScan(romm);
        }
      } catch (e) {
        logger.error(`[RomM] Scan trigger failed for request #${requestId}:`, e);
      }
    })
    .catch((e) => logger.error(`[PostCopy] Error for request #${requestId}:`, e));
}

/** Mark a download as failed due to wrong platform, reset request, record failure, and clean up. */
async function rejectWrongPlatform(
  downloadId: number, requestId: number, msg: string,
  download: { downloadType: string; torrentHash: string | null; nzbId: string | null; torrentName: string | null; indexer: string | null },
  sourcePath: string,
): Promise<void> {
  logger.error(`[PostCopy] ${msg}`);
  await prisma.download.update({ where: { id: downloadId }, data: { status: "FAILED", error: msg } });
  await prisma.request.update({ where: { id: requestId }, data: { status: "APPROVED" } });
  logger.log(`[PostCopy] Request #${requestId} reset to APPROVED for retry`);
  if (download.indexer) recordIndexerFailure(download.indexer);
  await cleanupWrongDownload(download, sourcePath);
}

/**
 * Clean up a download that was for the wrong platform.
 * Removes the torrent from qBittorrent and/or deletes downloaded files from disk.
 */
async function cleanupWrongDownload(
  download: { downloadType: string; torrentHash: string | null; nzbId: string | null; torrentName: string | null },
  sourcePath?: string,
): Promise<void> {
  try {
    // Remove torrent from qBittorrent (deletes data too)
    if (download.torrentHash) {
      const qbit = await getCachedQBittorrentClient();
      if (qbit) {
        logger.log(`[PostCopy] Removing wrong-platform torrent from qBittorrent: ${download.torrentHash}`);
        await qbit.deleteTorrents([download.torrentHash], true);
      }
    }

    // Delete downloaded files from disk (usenet and any other downloads)
    if (sourcePath && fs.existsSync(sourcePath)) {
      // Safety: only delete within the downloads directory
      const resolved = path.resolve(sourcePath);
      if (!isSubPath(DOWNLOADS_PATH, resolved)) {
        logger.log(`[PostCopy] Skipping cleanup: "${resolved}" is outside ${DOWNLOADS_PATH}`);
        return;
      }
      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) {
        fs.rmSync(sourcePath, { recursive: true, force: true });
        logger.log(`[PostCopy] Deleted wrong-platform directory: ${sourcePath}`);
      } else {
        fs.unlinkSync(sourcePath);
        logger.log(`[PostCopy] Deleted wrong-platform file: ${sourcePath}`);
      }
    }
  } catch (e) {
    logger.error(`[PostCopy] Failed to clean up wrong download:`, e);
  }
}

/** Default path where completed downloads are mounted inside the Rommseer container. */
const DOWNLOADS_PATH = "/downloads";

/** Get the source file/directory path from the download client.
 *  Download clients report paths from THEIR container's perspective,
 *  but Rommseer has the completed downloads mounted at /downloads.
 *  So we use the download name to locate the files in /downloads/.
 */
async function getSourcePath(
  download: { downloadType: string; nzbId: string | null; torrentHash: string | null; torrentName: string | null; magnetUrl: string | null }
): Promise<string | null> {
  // Direct downloads (e.g. Internet Archive): file path stored in magnetUrl field
  if (download.downloadType === "direct" && download.magnetUrl) {
    const resolved = path.resolve(download.magnetUrl);
    if (resolved.startsWith(path.resolve(DOWNLOADS_PATH)) && fs.existsSync(resolved)) {
      logger.log(`[PostCopy] Direct download at: ${resolved}`);
      return resolved;
    }
    // Also try /downloads/<torrentName> as fallback
    if (download.torrentName) {
      const fallback = path.join(DOWNLOADS_PATH, download.torrentName);
      if (fs.existsSync(fallback)) {
        logger.log(`[PostCopy] Direct download found at: ${fallback}`);
        return fallback;
      }
    }
    logger.log(`[PostCopy] Direct download file not found: ${download.magnetUrl}`);
    return null;
  }

  if (download.downloadType === "usenet" && download.nzbId) {
    const sabnzbd = await getCachedSABnzbdClient();
    if (!sabnzbd) return null;
    try {
      const history = await sabnzbd.getHistory(100);
      const slot = history.slots.find((s) => s.nzo_id === download.nzbId);
      if (!slot) return null;

      // Try to find the download folder in our mounted /downloads path
      const name = slot.name;
      const candidates = [
        path.join(DOWNLOADS_PATH, name),                      // /downloads/<name>
        path.join(DOWNLOADS_PATH, slot.category, name),       // /downloads/<category>/<name>
      ];

      // Also try the raw storage path in case volumes align (validate it's safe)
      if (slot.storage && path.resolve(slot.storage).startsWith(DOWNLOADS_PATH)) candidates.push(slot.storage);

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          logger.log(`[PostCopy] Found SABnzbd download at: ${candidate}`);
          return candidate;
        }
      }

      logger.log(`[PostCopy] SABnzbd download "${name}" not found. Tried: ${candidates.join(", ")}`);
      // List /downloads for debugging
      try {
        const entries = fs.readdirSync(DOWNLOADS_PATH);
        logger.log(`[PostCopy] Contents of ${DOWNLOADS_PATH}: ${entries.join(", ")}`);
      } catch { /* ignore */ }
      return null;
    } catch (e) {
      logger.error(`[PostCopy] SABnzbd history lookup failed:`, e);
      return null;
    }
  }

  if (download.torrentHash) {
    const qbit = await getCachedQBittorrentClient();
    if (!qbit) return null;
    try {
      const torrents = await qbit.getTorrents(undefined, "rommseer");
      const torrent = torrents.find((t) => t.hash === download.torrentHash);
      if (!torrent) return null;

      const name = torrent.name || download.torrentName;
      if (!name) return torrent.content_path || null;

      const candidates = [
        path.join(DOWNLOADS_PATH, name),                      // /downloads/<name>
        path.join(DOWNLOADS_PATH, torrent.category || "", name), // /downloads/<category>/<name>
      ];

      // Also try the raw content_path in case volumes align (validate it's safe)
      if (torrent.content_path && path.resolve(torrent.content_path).startsWith(DOWNLOADS_PATH)) candidates.push(torrent.content_path);

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          logger.log(`[PostCopy] Found qBittorrent download at: ${candidate}`);
          return candidate;
        }
      }

      logger.log(`[PostCopy] qBittorrent download "${name}" not found. Tried: ${candidates.join(", ")}`);
      try {
        const entries = fs.readdirSync(DOWNLOADS_PATH);
        logger.log(`[PostCopy] Contents of ${DOWNLOADS_PATH}: ${entries.join(", ")}`);
      } catch { /* ignore */ }
      return null;
    } catch (e) {
      logger.error(`[PostCopy] qBittorrent lookup failed:`, e);
      return null;
    }
  }

  return null;
}

/** Determine the RomM platform folder slug. */
async function getPlatformSlug(
  platform: { name: string; slug: string }
): Promise<string | null> {
  try {
    const romm = await getCachedRomMClient();
    if (romm) {
      const platforms = await romm.getPlatforms();
      const match = platforms.find(
        (p) =>
          p.name.toLowerCase() === platform.name.toLowerCase() ||
          p.slug.toLowerCase() === platform.slug.toLowerCase() ||
          p.slug.toLowerCase() === platform.name.toLowerCase().replace(/\s+/g, "-")
      );
      if (match) {
        // Use fs_slug (actual folder name on disk) if available, otherwise slug
        const slug = match.fs_slug || match.slug;
        logger.log(`[PostCopy] Matched RomM platform: "${match.name}" -> folder "${slug}"`);
        return slug;
      }
    }
  } catch (e) {
    logger.error(`[PostCopy] RomM platform lookup failed:`, e);
  }

  // Fallback: use the platform slug from our database
  return platform.slug;
}

/**
 * Extract a .zip / .7z / .rar archive into destDir.
 * Tries `7z e` first, then falls back to `unar` (better RAR support).
 * Returns the number of ROM files extracted.
 */
function extractArchiveToDir(archivePath: string, destDir: string): number {
  fs.mkdirSync(destDir, { recursive: true });

  // Snapshot files already present so we can detect what was extracted
  const before = new Set(fs.existsSync(destDir) ? fs.readdirSync(destDir) : []);

  // Try 7z first, then unar as fallback — use spawnSync with arg arrays to prevent command injection
  let extracted = false;
  const result7z = spawnSync("7z", ["e", archivePath, `-o${destDir}`, "-y"], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120_000,
  });

  if (result7z.status === 0) {
    extracted = true;
  } else {
    const err7z = result7z.stderr?.toString().trim() || result7z.error?.message || "unknown error";
    logger.log(`[PostCopy] 7z failed for "${path.basename(archivePath)}": ${err7z}`);
    // Try unar as fallback (better RAR/multi-format support)
    const resultUnar = spawnSync("unar", [
      "-force-overwrite", "-no-directory",
      "-output-directory", destDir,
      archivePath,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });

    if (resultUnar.status === 0) {
      extracted = true;
      logger.log(`[PostCopy] unar succeeded for "${path.basename(archivePath)}"`);
    } else {
      const errUnar = resultUnar.stderr?.toString().trim() || resultUnar.error?.message || "unknown error";
      logger.error(`[PostCopy] unar also failed for "${path.basename(archivePath)}": ${errUnar}`);
    }
  }

  if (!extracted) return 0;

  // Count newly-appeared actual ROM files (not archives spawned by extraction)
  const ARCHIVE_EXTS_LOCAL = new Set([".zip", ".7z", ".rar"]);
  const after = fs.readdirSync(destDir);
  const newRoms = after.filter((f) => {
    if (before.has(f)) return false;
    const ext = path.extname(f).toLowerCase();
    return ROM_EXTENSIONS.has(ext) && !ARCHIVE_EXTS_LOCAL.has(ext);
  });

  if (newRoms.length === 0) {
    logger.log(`[PostCopy] Archive "${path.basename(archivePath)}" extracted but no ROM files found inside`);
  } else {
    logger.log(`[PostCopy] Extracted: ${newRoms.join(", ")}`);
  }
  return newRoms.length;
}

/** Find ROM files in a path (file or directory). */
function findRomFiles(sourcePath: string): string[] {
  if (!fs.existsSync(sourcePath)) return [];

  const stat = fs.statSync(sourcePath);

  if (stat.isFile()) {
    const ext = path.extname(sourcePath).toLowerCase();
    return ROM_EXTENSIONS.has(ext) ? [sourcePath] : [];
  }

  if (stat.isDirectory()) {
    const files: string[] = [];
    scanDirectory(sourcePath, files, 0);
    return files;
  }

  return [];
}

/** Recursively scan a directory for ROM files (max depth 3). */
function scanDirectory(dir: string, results: string[], depth: number): void {
  if (depth > 3) return;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDirectory(fullPath, results, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ROM_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // Permission error or similar, skip
  }
}
