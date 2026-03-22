import { prisma } from "@/lib/db";
import { getSABnzbdClient } from "@/lib/sabnzbd";
import { getQBittorrentClient } from "@/lib/qbittorrent";
import { getRomMClient } from "@/lib/romm";
import * as fs from "fs";
import * as path from "path";

/** Platform slug mapping: RomM platform slug → filesystem folder name.
 *  RomM expects ROMs in: <library>/<platform_fs_slug>/<rom_files>
 */

/** Known ROM extensions per platform (reuse from prowlarr.ts concept). */
const ROM_EXTENSIONS = new Set([
  // Nintendo
  ".gb", ".gbc", ".gba", ".nds", ".dsi", ".srl", ".3ds", ".cia", ".cxi", ".cci",
  ".nes", ".unf", ".unif", ".fds", ".sfc", ".smc", ".fig", ".swc",
  ".n64", ".z64", ".v64", ".ndd", ".iso", ".gcm", ".gcz", ".rvz", ".nkit", ".ciso",
  ".wbfs", ".wad", ".wud", ".wux", ".rpx", ".wua", ".nsp", ".xci", ".nsz", ".xcz",
  ".vb", ".vboy", ".min", ".mgw",
  // Sony
  ".pbp", ".cso", ".chd", ".pkg", ".vpk",
  // Sega
  ".sms", ".gg", ".md", ".gen", ".smd", ".32x", ".cue", ".gdi", ".cdi",
  // Other
  ".a26", ".a52", ".a78", ".lnx", ".pce", ".ngp", ".ngc", ".ws", ".wsc",
  ".col", ".sg",
  // Archives that may contain ROMs
  ".zip", ".7z", ".rar",
]);

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
    console.log(`[PostCopy] No RomM library path configured, skipping copy`);
    return false;
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
    console.error(`[PostCopy] Download #${downloadId} not found`);
    return false;
  }

  // Get the source path from the download client
  const sourcePath = await getSourcePath(download);
  if (!sourcePath) {
    console.log(`[PostCopy] Could not determine source path for download #${downloadId}`);
    return false;
  }

  // Determine platform slug for destination folder
  const platformSlug = await getPlatformSlug(download.request.game.platform);
  if (!platformSlug) {
    console.error(`[PostCopy] Could not determine platform slug for "${download.request.game.platform.name}"`);
    return false;
  }

  const destDir = path.join(settings.rommLibraryPath, platformSlug);

  console.log(`[PostCopy] Copying from "${sourcePath}" to "${destDir}" for request #${requestId}`);

  try {
    // Ensure destination directory exists
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
      console.log(`[PostCopy] Created directory: ${destDir}`);
    }

    // Collect ROM files from source
    const romFiles = findRomFiles(sourcePath);
    if (romFiles.length === 0) {
      console.log(`[PostCopy] No ROM files found in "${sourcePath}"`);
      return false;
    }

    let copied = 0;
    for (const srcFile of romFiles) {
      const filename = path.basename(srcFile);
      const destFile = path.join(destDir, filename);

      if (fs.existsSync(destFile)) {
        const srcStat = fs.statSync(srcFile);
        const destStat = fs.statSync(destFile);
        if (srcStat.size === destStat.size) {
          console.log(`[PostCopy] "${filename}" already exists (same size), skipping`);
          continue;
        }
      }

      console.log(`[PostCopy] Copying "${filename}" (${formatSize(fs.statSync(srcFile).size)})`);
      fs.copyFileSync(srcFile, destFile);
      copied++;
    }

    console.log(`[PostCopy] Done: ${copied} file(s) copied to ${destDir}`);
    return copied > 0;
  } catch (e) {
    console.error(`[PostCopy] Failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/** Get the source file/directory path from the download client. */
async function getSourcePath(
  download: { downloadType: string; nzbId: string | null; torrentHash: string | null }
): Promise<string | null> {
  if (download.downloadType === "usenet" && download.nzbId) {
    const sabnzbd = await getSABnzbdClient();
    if (!sabnzbd) return null;
    try {
      const history = await sabnzbd.getHistory(100);
      const slot = history.slots.find((s) => s.nzo_id === download.nzbId);
      return slot?.storage || null;
    } catch (e) {
      console.error(`[PostCopy] SABnzbd history lookup failed:`, e);
      return null;
    }
  }

  if (download.torrentHash) {
    const qbit = await getQBittorrentClient();
    if (!qbit) return null;
    try {
      const torrents = await qbit.getTorrents();
      const torrent = torrents.find((t) => t.hash === download.torrentHash);
      return torrent?.content_path || null;
    } catch (e) {
      console.error(`[PostCopy] qBittorrent lookup failed:`, e);
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
    const romm = await getRomMClient();
    if (romm) {
      const platforms = await romm.getPlatforms();
      const match = platforms.find(
        (p) =>
          p.name.toLowerCase() === platform.name.toLowerCase() ||
          p.slug.toLowerCase() === platform.slug.toLowerCase() ||
          p.slug.toLowerCase() === platform.name.toLowerCase().replace(/\s+/g, "-")
      );
      if (match) return match.slug;
    }
  } catch (e) {
    console.error(`[PostCopy] RomM platform lookup failed:`, e);
  }

  // Fallback: use the platform slug from our database
  return platform.slug;
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
  } catch (e) {
    // Permission error or similar, skip
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
