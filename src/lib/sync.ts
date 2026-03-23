/**
 * Shared sync + auto-retry logic for SABnzbd/qBittorrent downloads.
 * Used by both requests/route.ts and downloads/route.ts.
 */
import { prisma } from "@/lib/db";
import { getCachedSABnzbdClient, getCachedQBittorrentClient } from "@/lib/clients";
import { autoGrabForRequest } from "@/lib/autograb";
import { copyAndScan } from "@/lib/postcopy";

interface DownloadRecord {
  id: number;
  requestId: number;
  downloadType: string;
  nzbId: string | null;
  torrentHash: string | null;
  status: string;
  progress: number;
  request?: { status: string } | null;
}

interface StatusUpdate {
  id: number;
  data: { status?: string; progress?: number; error?: string };
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
  if (qbit) {
    try {
      const torrents = await qbit.getTorrents(undefined, "rommseer");
      const tMap = new Map(torrents.map((t) => [t.hash, t]));

      for (const dl of downloads) {
        if (dl.downloadType === "usenet" || !dl.torrentHash || dl.status !== "DOWNLOADING") continue;
        const t = tMap.get(dl.torrentHash);
        if (!t) continue;

        const progress = Math.round(t.progress * 100);
        if (["error", "missingFiles"].includes(t.state)) {
          downloadUpdates.push({ id: dl.id, data: { status: "FAILED", progress } });
          dl.status = "FAILED";
        } else if (t.progress >= 1) {
          downloadUpdates.push({ id: dl.id, data: { status: "COMPLETED", progress: 100 } });
          dl.status = "COMPLETED";
          requestUpdates.push({ id: dl.requestId, data: { status: "AVAILABLE" } });
          completedPairs.push({ requestId: dl.requestId, downloadId: dl.id });
          console.log(`[Sync] Request #${dl.requestId}: torrent completed, marked AVAILABLE`);
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
