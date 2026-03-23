import { prisma } from "@/lib/db";
import { ProwlarrRelease } from "@/lib/prowlarr";
import { getCachedProwlarrClient, getCachedQBittorrentClient, getCachedSABnzbdClient } from "@/lib/clients";

interface AutoGrabResult {
  success: boolean;
  message: string;
  torrentTitle?: string;
  indexer?: string;
}

/**
 * Search Prowlarr and send best result to qBittorrent (torrent) or SABnzbd (usenet).
 * Skips previously failed results and tries up to 5 candidates.
 */
export async function autoGrabForRequest(requestId: number): Promise<AutoGrabResult> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.prowlarrAutoGrab) return { success: false, message: "Auto-grab not enabled" };

  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: { game: { include: { platform: true } } },
  });
  if (!request) return { success: false, message: "Request not found" };
  if (request.status === "DOWNLOADING") {
    // Already being handled
  }

  const [prowlarr, qbit, sabnzbd] = await Promise.all([
    getCachedProwlarrClient(), getCachedQBittorrentClient(), getCachedSABnzbdClient(),
  ]);
  if (!prowlarr) return { success: false, message: "Prowlarr not configured" };
  if (!qbit && !sabnzbd) return { success: false, message: "No download client configured" };

  try {
    // Exclude previously failed titles
    const failed = await prisma.download.findMany({ where: { requestId, status: "FAILED" }, select: { torrentName: true } });
    const failedTitles = new Set(failed.map((d) => d.torrentName).filter(Boolean));
    if (failedTitles.size) console.log(`[AutoGrab] Excluding ${failedTitles.size} failed:`, Array.from(failedTitles));

    const allResults = await prowlarr.searchForRom(
      request.game.name, request.game.platform.name,
      settings.prowlarrSearchTemplate || undefined, settings.prowlarrMinSeeders, settings.prowlarrMaxSizeMb,
    );
    const results = allResults.filter((r) => !failedTitles.has(r.title));

    if (!results.length) {
      const msg = failedTitles.size ? `No new results (${failedTitles.size} failed excluded)` : `No results for "${request.game.name}"`;
      return { success: false, message: msg };
    }

    // Boost preferred indexers
    if (settings.prowlarrPreferredIndexers) {
      const pref = settings.prowlarrPreferredIndexers.split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
      if (pref.length) results.sort((a, b) => +pref.includes(b.indexer.toLowerCase()) - +pref.includes(a.indexer.toLowerCase()));
    }

    // Try up to 5 results
    let lastErr = "";
    for (let i = 0; i < Math.min(results.length, 5); i++) {
      const r = results[i];
      console.log(`[AutoGrab] Try ${i + 1}: "${r.title}" (${r.protocol}, ${r.indexer})`);
      try {
        if (r.protocol === "usenet") {
          if (!sabnzbd) { lastErr = "SABnzbd not configured"; continue; }
          return await grabUsenet(prowlarr, sabnzbd, r, requestId, settings.sabnzbdCategory, request.game.name);
        } else {
          if (!qbit) { lastErr = "qBittorrent not configured"; continue; }
          return await grabTorrent(prowlarr, qbit, r, requestId, settings, request.game.name);
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : "Download failed";
        console.log(`[AutoGrab] Result ${i + 1} failed: ${lastErr}`);
      }
    }
    return { success: false, message: `All results failed. Last: ${lastErr}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Auto-grab failed";
    await prisma.download.create({ data: { requestId, status: "FAILED", error: msg } });
    return { success: false, message: msg };
  }
}

async function grabTorrent(
  prowlarr: NonNullable<Awaited<ReturnType<typeof getCachedProwlarrClient>>>,
  qbit: NonNullable<Awaited<ReturnType<typeof getCachedQBittorrentClient>>>,
  r: ProwlarrRelease, requestId: number,
  settings: { qbitCategory: string; qbitSavePath: string }, gameName: string,
): Promise<AutoGrabResult> {
  const opts = { category: settings.qbitCategory || "rommseer", savepath: settings.qbitSavePath || undefined, tags: `rommseer,${gameName},auto-grab` };

  if (r.magnetUrl) {
    await qbit.addTorrentByUrl(r.magnetUrl, opts);
  } else if (r.downloadUrl) {
    const file = await prowlarr.downloadFile(r.downloadUrl);
    if (!file) throw new Error("Failed to download .torrent file");
    await qbit.addTorrentByFile(file, `${r.title}.torrent`, opts);
  } else {
    throw new Error("No download URL");
  }

  await prisma.download.create({ data: { requestId, downloadType: "torrent", magnetUrl: r.magnetUrl || r.downloadUrl, torrentName: r.title, torrentHash: r.infoHash, status: "DOWNLOADING" } });
  await prisma.request.update({ where: { id: requestId }, data: { status: "DOWNLOADING" } });
  return { success: true, message: `Grabbed "${r.title}" from ${r.indexer} via qBittorrent`, torrentTitle: r.title, indexer: r.indexer };
}

async function grabUsenet(
  prowlarr: NonNullable<Awaited<ReturnType<typeof getCachedProwlarrClient>>>,
  sabnzbd: NonNullable<Awaited<ReturnType<typeof getCachedSABnzbdClient>>>,
  r: ProwlarrRelease, requestId: number, category: string, gameName: string,
): Promise<AutoGrabResult> {
  if (!r.downloadUrl) throw new Error("No download URL for NZB");

  const nzbFile = await prowlarr.downloadFile(r.downloadUrl);
  const opts = { category: category || "rommseer", name: gameName };
  const nzoIds = nzbFile
    ? await sabnzbd.addNzbByFile(nzbFile, `${r.title}.nzb`, opts)
    : await sabnzbd.addNzbByUrl(r.downloadUrl, opts);

  const nzbId = nzoIds?.[0] || null;
  await prisma.download.create({ data: { requestId, downloadType: "usenet", torrentName: r.title, nzbId, magnetUrl: r.downloadUrl, status: "DOWNLOADING" } });
  await prisma.request.update({ where: { id: requestId }, data: { status: "DOWNLOADING" } });
  return { success: true, message: `Grabbed "${r.title}" from ${r.indexer} via SABnzbd`, torrentTitle: r.title, indexer: r.indexer };
}
