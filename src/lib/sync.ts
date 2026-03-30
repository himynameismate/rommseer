/**
 * Shared sync + auto-retry logic for SABnzbd/qBittorrent downloads.
 * Includes a background sync interval that automatically detects completed,
 * failed, and stalled downloads without requiring the admin to visit the page.
 */
import { prisma } from "@/lib/db";
import { getCachedSABnzbdClient, getCachedQBittorrentClient } from "@/lib/clients";
import { autoGrabForRequest, recordIndexerFailure } from "@/lib/autograb";
import { copyAndScan } from "@/lib/postcopy";

// ─── Background sync interval ─────────────────────────────────────────
const DOWNLOAD_SYNC_MS = 30_000;  // 30s — check active downloads
const AUTOGRAB_SYNC_MS = 120_000; // 2min — check approved requests for auto-grab
let bgSyncStarted = false;
let bgSyncRunning = false;
let autoGrabRunning = false;

/**
 * Start background sync loops. Called lazily on first API request.
 * Two separate intervals: fast loop for download monitoring, slower loop for auto-grab.
 */
export function startBackgroundSync(): void {
  if (bgSyncStarted) return;
  bgSyncStarted = true;
  console.log(`[Sync] Background sync started (downloads: ${DOWNLOAD_SYNC_MS / 1000}s, auto-grab: ${AUTOGRAB_SYNC_MS / 1000}s)`);

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
      console.error("[Sync] Background sync error:", e);
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
            if (r.success) console.log(`[Sync] Auto-grabbed #${req.id}: ${r.message}`);
            else if (r.message !== "Auto-grab not enabled" && r.message !== "Already grabbing") {
              console.log(`[Sync] Auto-grab #${req.id}: ${r.message}`);
            }
          })
          .catch((e) => console.error(`[Sync] Auto-grab #${req.id} error:`, e));
      }
    } catch (e) {
      console.error("[Sync] Auto-grab loop error:", e);
    } finally {
      autoGrabRunning = false;
    }
  }, AUTOGRAB_SYNC_MS);
}

/** Check if a torrent is stalled (no seeds, no peers, no progress) */
function isTorrentStalled(t: { state: string; num_seeds: number; num_leechs: number; progress: number; added_on: number; dlspeed: number }): boolean {
  const seeds = t.num_seeds;
  const peers = t.num_leechs;
  const speed = t.dlspeed;

  // Not stalled if it has any seeds, peers, or download speed
  if (seeds > 0 || peers > 0 || speed > 0) return false;

  // Not stalled if already has significant progress (might just be paused temporarily)
  if (t.progress > 0.5) return false;

  // Only mark as stalled if the torrent has been around for at least 5 minutes
  // (give new torrents time to find peers)
  const ageSeconds = Math.floor(Date.now() / 1000) - t.added_on;
  if (ageSeconds < 300) return false;

  // States that indicate staleness
  const stalledStates = ["stalledDL", "metaDL", "forcedMetaDL", "queuedDL"];
  if (stalledStates.includes(t.state)) return true;

  // Also catch "downloading" with 0 speed and 0 seeds for 5+ minutes
  if (t.state === "downloading" && speed === 0) return true;

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
  status: string;
  progress: number;
  createdAt?: Date | string | null;
  request?: { status: string } | null;
}

interface StatusUpdate {
  id: number;
  data: { status?: string; progress?: number; error?: string; torrentHash?: string };
}

interface RequestUpdate {
  id: number;
  data: { status: string };
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

  const downloadUpdates: StatusUpdate[] = [];
  const requestUpdates: RequestUpdate[] = [];
  const completedPairs: { requestId: number; downloadId: number }[] = [];

  // Sync SABnzbd status
  const sabnzbd = await getCachedSABnzbdClient();
  if (sabnzbd) {
    try {
      const [queue, history] = await Promise.all([sabnzbd.getQueue(), sabnzbd.getHistory(100)]);
      const qMap = new Map(queue.slots.map((s) => [s.nzo_id, s]));
      const hMap = new Map(history.slots.map((s) => [s.nzo_id, s]));

      for (const dl of downloads) {
        if (dl.downloadType !== "usenet" || !dl.nzbId || dl.status !== "DOWNLOADING") continue;
        const hs = hMap.get(dl.nzbId);
        const qs = qMap.get(dl.nzbId);
        if (hs) {
          console.log(`[Sync] SABnzbd history for ${dl.nzbId}: status="${hs.status}", fail_message="${hs.fail_message || ""}"`);
        }

        const isFailed = hs && hs.status !== "Completed" && !qMap.has(dl.nzbId);
        if (isFailed && hs) {
          downloadUpdates.push({ id: dl.id, data: { status: "FAILED", error: hs.fail_message || hs.status } });
          dl.status = "FAILED";
          if (dl.indexer) recordIndexerFailure(dl.indexer);
        } else if (hs?.status === "Completed") {
          downloadUpdates.push({ id: dl.id, data: { status: "COMPLETED", progress: 100 } });
          dl.status = "COMPLETED";
          requestUpdates.push({ id: dl.requestId, data: { status: "AVAILABLE" } });
          completedPairs.push({ requestId: dl.requestId, downloadId: dl.id });
          console.log(`[Sync] Request #${dl.requestId}: download completed, marked AVAILABLE`);
        } else if (qs) {
          const progress = Math.round(parseFloat(qs.percentage));
          if (progress !== Math.round(dl.progress)) {
            downloadUpdates.push({ id: dl.id, data: { progress } });
          }
        }
      }
    } catch (e) { console.error("SABnzbd sync:", e); }
  }

  // Sync qBittorrent status (filter by rommseer category)
  const qbit = await getCachedQBittorrentClient();
  const stalledHashes: string[] = []; // Track stalled torrents for deletion
  if (qbit) {
    try {
      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      const category = settings?.qbitCategory || "rommseer";
      const torrents = await qbit.getTorrents(undefined, category);
      const tMap = new Map(torrents.map((t) => [t.hash, t]));
      // Also build a name map for downloads without a stored hash
      const tNameMap = new Map(torrents.map((t) => [t.name.toLowerCase(), t]));

      for (const dl of downloads) {
        if (dl.downloadType === "usenet" || dl.status !== "DOWNLOADING") continue;
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
            console.log(`[Sync] Request #${dl.requestId}: torrent "${dl.torrentName || dl.torrentHash}" not found in qBittorrent after ${Math.round(ageMs / 60000)}min, marking FAILED`);
            downloadUpdates.push({ id: dl.id, data: { status: "FAILED", error: "Torrent not found in qBittorrent (never added or removed)" } });
            dl.status = "FAILED";
            if (dl.indexer) recordIndexerFailure(dl.indexer);
          }
          continue;
        }

        const progress = Math.round(t.progress * 100);
        if (["error", "missingFiles"].includes(t.state)) {
          downloadUpdates.push({ id: dl.id, data: { status: "FAILED", progress, error: `Torrent error: ${t.state}` } });
          dl.status = "FAILED";
          stalledHashes.push(t.hash);
        } else if (t.progress >= 1) {
          downloadUpdates.push({ id: dl.id, data: { status: "COMPLETED", progress: 100 } });
          dl.status = "COMPLETED";
          requestUpdates.push({ id: dl.requestId, data: { status: "AVAILABLE" } });
          completedPairs.push({ requestId: dl.requestId, downloadId: dl.id });
          console.log(`[Sync] Request #${dl.requestId}: torrent completed, marked AVAILABLE`);
        } else if (isTorrentStalled(t)) {
          // Torrent has 0 seeds/peers and no progress — it will never complete
          console.log(`[Sync] Request #${dl.requestId}: torrent "${t.name}" is stalled (seeds: ${t.num_seeds}, peers: ${t.num_leechs}, state: ${t.state}, progress: ${progress}%)`);
          downloadUpdates.push({ id: dl.id, data: { status: "FAILED", progress, error: "Stalled: no seeds or peers available" } });
          dl.status = "FAILED";
          stalledHashes.push(t.hash);
          // Record indexer failure so consistently-stalling indexers get blocked
          if (dl.indexer) recordIndexerFailure(dl.indexer);
        } else if (progress !== Math.round(dl.progress)) {
          downloadUpdates.push({ id: dl.id, data: { progress } });
        }
      }
    } catch (e) { console.error("qBit sync:", e); }
  }

  // Batch DB updates using a transaction
  if (downloadUpdates.length > 0 || requestUpdates.length > 0) {
    await prisma.$transaction([
      ...downloadUpdates.map((u) => prisma.download.update({ where: { id: u.id }, data: u.data })),
      ...requestUpdates.map((u) => prisma.request.update({ where: { id: u.id }, data: u.data })),
    ]);
  }

  // Remove stalled/failed torrents from qBittorrent (free up space)
  if (qbit && stalledHashes.length > 0) {
    try {
      console.log(`[Sync] Removing ${stalledHashes.length} stalled/failed torrent(s) from qBittorrent`);
      await qbit.deleteTorrents(stalledHashes, true);
    } catch (e) { console.error("[Sync] Failed to remove stalled torrents:", e); }
  }

  // Trigger copy+scan for completed downloads (non-blocking)
  for (const { requestId, downloadId } of completedPairs) {
    copyAndScan(requestId, downloadId);
  }

  // Auto-retry failed downloads
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
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

  for (const rid of Array.from(failedIds)) {
    const count = await prisma.download.count({ where: { requestId: rid } });
    if (count >= 3) {
      console.log(`[AutoRetry] #${rid}: max retries (${count}), resetting to APPROVED`);
      await prisma.request.update({ where: { id: rid }, data: { status: "APPROVED" } });
      continue;
    }
    console.log(`[AutoRetry] #${rid}: retrying (${count + 1}/3)`);
    await prisma.request.update({ where: { id: rid }, data: { status: "APPROVED" } });
    autoGrabForRequest(rid).then((r) => console.log(`[AutoRetry] #${rid}:`, r.message)).catch((e) => console.error(`[AutoRetry] #${rid}:`, e));
  }
}
