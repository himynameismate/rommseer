/**
 * Shared sync + auto-retry logic for SABnzbd/qBittorrent downloads.
 * Includes a background sync interval that automatically detects completed,
 * failed, and stalled downloads without requiring the admin to visit the page.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/utils";
import { getCachedSABnzbdClient, getCachedQBittorrentClient, getCachedRomMClient } from "@/lib/clients";
import { autoGrabForRequest, recordIndexerFailure } from "@/lib/autograb";
import { copyAndScan } from "@/lib/postcopy";
import { logActivity, notify } from "@/lib/notifications";

// ─── Background sync interval ─────────────────────────────────────────
const DOWNLOAD_SYNC_MS = 30_000;  // 30s — check active downloads
const AUTOGRAB_SYNC_MS = 120_000; // 2min — check approved requests for auto-grab
const LIBRARY_SYNC_CHECK_MS = 300_000; // 5min — check if library sync is due
let bgSyncStarted = false;
let bgSyncRunning = false;
let autoGrabRunning = false;
let librarySyncRunning = false;
let lastLibrarySync = 0;

/**
 * Start background sync loops. Called lazily on first API request.
 * Two separate intervals: fast loop for download monitoring, slower loop for auto-grab.
 */
export function startBackgroundSync(): void {
  if (bgSyncStarted) return;
  bgSyncStarted = true;
  logger.log(`[Sync] Background sync started (downloads: ${DOWNLOAD_SYNC_MS / 1000}s, auto-grab: ${AUTOGRAB_SYNC_MS / 1000}s)`);

  // Fast loop: monitor active downloads for completion/stalls
  setInterval(async () => {
    if (bgSyncRunning) return;
    bgSyncRunning = true;
    try {
      // Use count first to avoid expensive query when nothing is downloading
      const count = await prisma.download.count({ where: { status: "DOWNLOADING" } });
      if (count > 0) {
        const downloads = await prisma.download.findMany({
          where: { status: "DOWNLOADING" },
          include: { request: { select: { status: true } } },
        });
        await syncAndRetryDownloads(downloads, { useRequestInclude: true });
      }
    } catch (e) {
      logger.error("[Sync] Background sync error:", e);
    } finally {
      bgSyncRunning = false;
    }
  }, DOWNLOAD_SYNC_MS);

  // Slower loop: pick up APPROVED requests for auto-grab
  setInterval(async () => {
    if (autoGrabRunning) return;
    autoGrabRunning = true;
    try {
      const approved = await prisma.request.findMany({
        where: {
          status: "APPROVED",
          downloads: { none: { status: "DOWNLOADING" } },
        },
        select: { id: true },
      });
      for (const req of approved) {
        autoGrabForRequest(req.id)
          .then((r) => {
            if (r.success) logger.log(`[Sync] Auto-grabbed #${req.id}: ${r.message}`);
            else if (r.message !== "Auto-grab not enabled" && r.message !== "Already grabbing") {
              logger.log(`[Sync] Auto-grab #${req.id}: ${r.message}`);
            }
          })
          .catch((e) => logger.error(`[Sync] Auto-grab #${req.id} error:`, e));
      }
    } catch (e) {
      logger.error("[Sync] Auto-grab loop error:", e);
    } finally {
      autoGrabRunning = false;
    }
  }, AUTOGRAB_SYNC_MS);

  // Library sync loop: periodically sync RomM library to update game availability
  setInterval(async () => {
    if (librarySyncRunning) return;
    try {
      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      const syncHours = settings?.librarySyncHours ?? 6;
      if (syncHours <= 0) return; // Disabled

      const syncMs = syncHours * 60 * 60 * 1000;
      if (Date.now() - lastLibrarySync < syncMs) return;

      librarySyncRunning = true;
      lastLibrarySync = Date.now();
      await syncRomMLibrary();
    } catch (e) {
      logger.error("[Sync] Library sync error:", e);
    } finally {
      librarySyncRunning = false;
    }
  }, LIBRARY_SYNC_CHECK_MS);
}

/**
 * Sync RomM library: fetch all ROMs, match against local Game records,
 * and update isAvailable + rommId fields.
 * Also resets isAvailable=false for games that are no longer in RomM.
 */
async function syncRomMLibrary(): Promise<void> {
  const romm = await getCachedRomMClient();
  if (!romm) return;

  logger.log("[LibrarySync] Starting RomM library sync...");

  try {
    const platforms = await romm.getPlatforms();
    const platformById = new Map(platforms.map((p) => [p.id, p]));

    // Fetch ALL ROMs in a single call to get the complete picture
    const allRoms = await romm.getRoms();

    // Collect all RomM ROM IDs that currently exist
    const activeRommIds = new Set<number>();
    let totalUpdated = 0;

    for (const rom of allRoms) {
      activeRommIds.add(rom.id);
      const platform = platformById.get(rom.platform_id);
      if (!platform) continue;

      if (rom.igdb_id) {
        // Match by (igdbId + platformSlug) so Advance Wars GBA and Switch
        // are treated as separate library entries.
        const updated = await prisma.game.updateMany({
          where: {
            igdbId: rom.igdb_id,
            isAvailable: false,
            platform: { slug: platform.slug },
          },
          data: { isAvailable: true, rommId: rom.id },
        });
        totalUpdated += updated.count;
      } else {
        // Fallback: match by name + platform (case-insensitive)
        const games = await prisma.game.findMany({
          where: { isAvailable: false, platform: { slug: platform.slug } },
          select: { id: true, name: true },
        });
        for (const game of games) {
          if (game.name.toLowerCase() === rom.name.toLowerCase()) {
            await prisma.game.update({
              where: { id: game.id },
              data: { isAvailable: true, rommId: rom.id },
            });
            totalUpdated++;
          }
        }
      }
    }

    // Reset isAvailable for games whose rommId is no longer in RomM
    const staleGames = await prisma.game.findMany({
      where: { isAvailable: true, rommId: { not: null } },
      select: { id: true, rommId: true, name: true },
    });

    let totalReset = 0;
    for (const game of staleGames) {
      if (game.rommId && !activeRommIds.has(game.rommId)) {
        await prisma.game.update({
          where: { id: game.id },
          data: { isAvailable: false, rommId: null },
        });
        totalReset++;
        logger.log(`[LibrarySync] Reset "${game.name}" — no longer in RomM (rommId=${game.rommId})`);
      }
    }

    logger.log(`[LibrarySync] Complete — ${totalUpdated} marked available, ${totalReset} reset`);
  } catch (e) {
    logger.error("[LibrarySync] Failed:", e instanceof Error ? e.message : e);
  }
}

/** Check if a torrent is currently showing stall symptoms (used to start/reset the stalledAt timer) */
function isTorrentShowingStall(t: { state: string; added_on: number; dlspeed: number }): boolean {
  const speed = t.dlspeed;

  // Not stalled if it has any download speed
  if (speed > 0) return false;

  // Give new torrents 5 minutes to find peers before considering them stalled
  const ageSeconds = Math.floor(Date.now() / 1000) - t.added_on;
  if (ageSeconds < 300) return false;

  // States that indicate staleness
  const stalledStates = ["stalledDL", "metaDL", "forcedMetaDL", "queuedDL"];
  if (stalledStates.includes(t.state)) return true;

  // Also catch "downloading" with 0 speed for 5+ minutes
  if (t.state === "downloading") return true;

  return false;
}

interface DownloadRecord {
  id: number;
  requestId: number;
  downloadType: string;
  nzbId: string | null;
  torrentHash: string | null;
  torrentName: string | null;
  indexer: string | null;
  stalledAt: Date | null;
  status: string;
  progress: number;
  createdAt?: Date | string | null;
  request?: { status: string } | null;
}

interface StatusUpdate {
  id: number;
  data: { status?: string; progress?: number; error?: string; torrentHash?: string; stalledAt?: Date | null };
}


/**
 * Sync download statuses from SABnzbd/qBittorrent, auto-retry failed downloads.
 * @param downloads - Download records to sync (with optional request include)
 * @param options - Control behavior: useRequestInclude to use dl.request instead of re-fetching
 */
export async function syncAndRetryDownloads(
  downloads: DownloadRecord[],
  options?: { useRequestInclude?: boolean }
): Promise<void> {
  if (!downloads.length) return;

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const downloadUpdates: StatusUpdate[] = [];
  const completedPairs: { requestId: number; downloadId: number }[] = [];

  // Sync SABnzbd status
  const sabnzbd = await getCachedSABnzbdClient();
  if (sabnzbd) {
    try {
      const [queue, history] = await Promise.all([sabnzbd.getQueue(), sabnzbd.getHistory(100)]);
      const qMap = new Map(queue.slots.map((s) => [s.nzo_id, s]));
      const hMap = new Map(history.slots.map((s) => [s.nzo_id, s]));

      for (const dl of downloads) {
        if (dl.downloadType === "direct") continue; // Direct downloads complete immediately, no sync needed
        if (dl.downloadType !== "usenet" || !dl.nzbId || dl.status !== "DOWNLOADING") continue;
        const hs = hMap.get(dl.nzbId);
        const qs = qMap.get(dl.nzbId);
        if (hs) {
          logger.log(`[Sync] SABnzbd history for ${dl.nzbId}: status="${hs.status}", fail_message="${hs.fail_message || ""}"`);
        }

        // SABnzbd history statuses that do NOT indicate failure — newly-added NZBs
        // can appear in history with status "Queued" before they start downloading.
        const SAB_NON_FAILED_STATUSES = new Set([
          "Completed", "Queued", "Downloading", "Fetching",
          "Verifying", "Repairing", "Extracting", "Moving", "Running",
        ]);
        const isFailed = hs && !SAB_NON_FAILED_STATUSES.has(hs.status) && !qMap.has(dl.nzbId);
        if (isFailed && hs) {
          downloadUpdates.push({ id: dl.id, data: { status: "FAILED", error: hs.fail_message || hs.status } });
          dl.status = "FAILED";
          if (dl.indexer) await recordIndexerFailure(dl.indexer);
        } else if (hs?.status === "Completed") {
          downloadUpdates.push({ id: dl.id, data: { status: "COMPLETED", progress: 100 } });
          dl.status = "COMPLETED";
          completedPairs.push({ requestId: dl.requestId, downloadId: dl.id });
          logger.log(`[Sync] Request #${dl.requestId}: download completed, starting copy`);
        } else if (qs) {
          const progress = Math.round(parseFloat(qs.percentage));
          if (progress !== Math.round(dl.progress)) {
            downloadUpdates.push({ id: dl.id, data: { progress } });
          }
        }
      }
    } catch (e) { logger.error("SABnzbd sync:", e); }
  }

  // Sync qBittorrent status (filter by rommseer category)
  const qbit = await getCachedQBittorrentClient();
  const stalledHashes: string[] = []; // Track stalled torrents for deletion
  if (qbit) {
    try {
      const category = settings?.qbitCategory || "rommseer";
      const stallDetectEnabled = settings?.stallDetectEnabled ?? true;
      const stallDetectMs = (settings?.stallDetectMinutes ?? 30) * 60 * 1000;
      const torrents = await qbit.getTorrents(undefined, category);
      const tMap = new Map(torrents.map((t) => [t.hash, t]));
      // Also build a name map for downloads without a stored hash
      const tNameMap = new Map(torrents.map((t) => [t.name.toLowerCase(), t]));

      for (const dl of downloads) {
        if (dl.downloadType === "usenet" || dl.downloadType === "direct" || dl.status !== "DOWNLOADING") continue;
        // Match by hash first, then by torrent name (strict: exact match only)
        let t = dl.torrentHash ? tMap.get(dl.torrentHash) : undefined;
        if (!t && dl.torrentName) {
          t = tNameMap.get(dl.torrentName.toLowerCase());
          // Store the hash for future lookups if we found the torrent
          if (t && !dl.torrentHash) {
            downloadUpdates.push({ id: dl.id, data: { torrentHash: t.hash } });
            dl.torrentHash = t.hash;
          }
        }
        if (!t) {
          // Torrent not found in qBittorrent — check if it's been missing long enough to mark failed
          const ageMs = Date.now() - new Date(dl.createdAt || 0).getTime();
          if (ageMs > 5 * 60 * 1000) {
            logger.log(`[Sync] Request #${dl.requestId}: torrent "${dl.torrentName || dl.torrentHash}" not found in qBittorrent after ${Math.round(ageMs / 60000)}min, marking FAILED`);
            downloadUpdates.push({ id: dl.id, data: { status: "FAILED", error: "Torrent not found in qBittorrent (never added or removed)" } });
            dl.status = "FAILED";
            if (dl.indexer) await recordIndexerFailure(dl.indexer);
          }
          continue;
        }

        const progress = Math.round(t.progress * 100);
        if (["error", "missingFiles"].includes(t.state)) {
          downloadUpdates.push({ id: dl.id, data: { status: "FAILED", progress, error: `Torrent error: ${t.state}` } });
          dl.status = "FAILED";
          stalledHashes.push(t.hash);
        } else if (t.progress >= 1) {
          downloadUpdates.push({ id: dl.id, data: { status: "COMPLETED", progress: 100, stalledAt: null } });
          dl.status = "COMPLETED";
          completedPairs.push({ requestId: dl.requestId, downloadId: dl.id });
          logger.log(`[Sync] Request #${dl.requestId}: torrent completed, starting copy`);
        } else if (stallDetectEnabled && isTorrentShowingStall(t)) {
          const now = new Date();
          if (!dl.stalledAt) {
            // First time we see this stall — start the timer
            logger.log(`[Sync] Request #${dl.requestId}: torrent "${t.name}" stall detected (state: ${t.state}, speed: 0, progress: ${progress}%) — waiting ${settings?.stallDetectMinutes ?? 30}min before retry`);
            downloadUpdates.push({ id: dl.id, data: { progress, stalledAt: now } });
            dl.stalledAt = now;
          } else {
            const stalledMs = now.getTime() - new Date(dl.stalledAt).getTime();
            if (stalledMs >= stallDetectMs) {
              // Stall timer expired — mark failed and remove
              logger.log(`[Sync] Request #${dl.requestId}: torrent "${t.name}" stalled for ${Math.round(stalledMs / 60000)}min, marking FAILED`);
              downloadUpdates.push({ id: dl.id, data: { status: "FAILED", progress, error: `Stalled for ${Math.round(stalledMs / 60000)} minutes with no progress` } });
              dl.status = "FAILED";
              stalledHashes.push(t.hash);
              if (dl.indexer) await recordIndexerFailure(dl.indexer);
            } else {
              // Still within grace period — just update progress
              const remainingMin = Math.round((stallDetectMs - stalledMs) / 60000);
              if (progress !== Math.round(dl.progress)) {
                downloadUpdates.push({ id: dl.id, data: { progress } });
              }
              logger.log(`[Sync] Request #${dl.requestId}: torrent "${t.name}" still stalled, ${remainingMin}min until retry`);
            }
          }
        } else {
          // Torrent is making progress — clear any stall timer
          if (dl.stalledAt) {
            downloadUpdates.push({ id: dl.id, data: { stalledAt: null } });
            dl.stalledAt = null;
          }
          if (progress !== Math.round(dl.progress)) {
            downloadUpdates.push({ id: dl.id, data: { progress } });
          }
        }
      }
    } catch (e) { logger.error("qBit sync:", e); }
  }

  if (downloadUpdates.length > 0) {
    await prisma.$transaction(
      downloadUpdates.map((u) => prisma.download.update({ where: { id: u.id }, data: u.data }))
    );
  }

  // Remove stalled/failed torrents from qBittorrent (free up space)
  if (qbit && stalledHashes.length > 0) {
    try {
      logger.log(`[Sync] Removing ${stalledHashes.length} stalled/failed torrent(s) from qBittorrent`);
      await qbit.deleteTorrents(stalledHashes, true);
    } catch (e) { logger.error("[Sync] Failed to remove stalled torrents:", e); }
  }

  // Log activities for status changes and notify
  for (const u of downloadUpdates) {
    if (u.data.status === "COMPLETED") {
      const dl = downloads.find((d) => d.id === u.id);
      if (dl) {
        logActivity("DOWNLOAD_COMPLETED", `Download completed for request #${dl.requestId}`, {
          requestId: dl.requestId, downloadId: dl.id,
        });
      }
    } else if (u.data.status === "FAILED" && u.data.error) {
      const dl = downloads.find((d) => d.id === u.id);
      if (dl) {
        logActivity("DOWNLOAD_FAILED", `Download failed: ${u.data.error}`, {
          requestId: dl.requestId, downloadId: dl.id, metadata: { error: u.data.error },
        });
      }
    }
  }

  for (const { requestId, downloadId } of completedPairs) {
    copyAndScan(requestId, downloadId);
  }

  if (!settings?.prowlarrAutoGrab) return;

  const failedIds = new Set<number>();
  for (const dl of downloads) {
    if (dl.status === "FAILED") {
      if (options?.useRequestInclude && dl.request) {
        // Issue #3: Use already-included request data instead of re-fetching
        if (dl.request.status === "DOWNLOADING") failedIds.add(dl.requestId);
      } else {
        failedIds.add(dl.requestId);
      }
    }
  }

  const failedArr = Array.from(failedIds);
  const retryCounts = await prisma.download.groupBy({
    by: ["requestId"],
    where: { requestId: { in: failedArr } },
    _count: true,
  });
  const countMap = new Map(retryCounts.map((c) => [c.requestId, c._count]));

  for (const rid of failedArr) {
    const count = countMap.get(rid) || 0;
    if (count >= 3) {
      logger.log(`[AutoRetry] #${rid}: max retries (${count}), resetting to APPROVED`);
      await prisma.request.update({ where: { id: rid }, data: { status: "APPROVED" } });
      continue;
    }
    logger.log(`[AutoRetry] #${rid}: retrying (${count + 1}/3)`);
    await prisma.request.update({ where: { id: rid }, data: { status: "APPROVED" } });
    autoGrabForRequest(rid).then((r) => logger.log(`[AutoRetry] #${rid}:`, r.message)).catch((e) => logger.error(`[AutoRetry] #${rid}:`, e));
  }
}
