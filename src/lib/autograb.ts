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
      console.log(`[AutoGrab] Try ${i + 1}: "${r.title}" (${r.protocol}, ${r.indexer}) [magnet:${!!r.magnetUrl}, hash:${!!r.infoHash}, url:${!!r.downloadUrl}]`);
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

/** Wait briefly then check if a torrent actually appeared in qBittorrent */
async function verifyTorrentAdded(
  qbit: NonNullable<Awaited<ReturnType<typeof getCachedQBittorrentClient>>>,
  title: string, category: string, infoHash?: string | null,
): Promise<void> {
  // Give qBit a moment to process the add
  await new Promise((r) => setTimeout(r, 3000));

  const torrents = await qbit.getTorrents(undefined, category);
  const normalized = title.toLowerCase();
  const hashLower = infoHash?.toLowerCase();

  // Check by hash first (most reliable — works even before metadata resolves)
  if (hashLower) {
    const foundByHash = torrents.some((t) => t.hash.toLowerCase() === hashLower);
    if (foundByHash) {
      console.log(`[AutoGrab] Verified torrent appeared in qBittorrent (matched by hash)`);
      return;
    }
  }

  // Check by title match
  const found = torrents.some((t) =>
    t.name.toLowerCase().includes(normalized) || normalized.includes(t.name.toLowerCase())
  );

  if (found) {
    console.log(`[AutoGrab] Verified torrent appeared in qBittorrent (matched by title)`);
    return;
  }

  // Check without category filter in case category creation failed
  const all = await qbit.getTorrents();
  if (hashLower) {
    const foundByHash = all.some((t) => t.hash.toLowerCase() === hashLower);
    if (foundByHash) {
      console.log(`[AutoGrab] Verified torrent appeared in qBittorrent (matched by hash, no category)`);
      return;
    }
  }

  const foundAny = all.some((t) => {
    const n = t.name.toLowerCase();
    return n.includes(normalized) || normalized.includes(n);
  });
  if (foundAny) {
    console.log(`[AutoGrab] Verified torrent appeared in qBittorrent (matched by title, no category)`);
    return;
  }

  // Check if any very recent torrent was added (within last 30 seconds)
  const now = Math.floor(Date.now() / 1000);
  const recentTorrent = all.find((t) => now - t.added_on < 30);
  if (recentTorrent) {
    console.log(`[AutoGrab] Verified torrent appeared in qBittorrent (recent add: "${recentTorrent.name}")`);
    return;
  }

  throw new Error("Torrent was not actually added to qBittorrent (silent failure)");
}

async function grabTorrent(
  prowlarr: NonNullable<Awaited<ReturnType<typeof getCachedProwlarrClient>>>,
  qbit: NonNullable<Awaited<ReturnType<typeof getCachedQBittorrentClient>>>,
  r: ProwlarrRelease, requestId: number,
  settings: { qbitCategory: string; qbitSavePath: string }, gameName: string,
): Promise<AutoGrabResult> {
  const category = settings.qbitCategory || "rommseer";
  const opts = { category, savepath: settings.qbitSavePath || undefined, tags: `rommseer,${gameName},auto-grab` };
  let usedMethod = "";

  // Strategy 1: Use magnet URL directly
  if (r.magnetUrl) {
    console.log(`[AutoGrab] Using magnet URL`);
    await qbit.addTorrentByUrl(r.magnetUrl, opts);
    usedMethod = "magnet";
  }
  // Strategy 2: Construct magnet from infoHash (most torrent results include this)
  else if (r.infoHash) {
    const magnet = `magnet:?xt=urn:btih:${r.infoHash}&dn=${encodeURIComponent(r.title)}`;
    console.log(`[AutoGrab] Constructed magnet from infoHash: ${r.infoHash}`);
    await qbit.addTorrentByUrl(magnet, opts);
    usedMethod = "infoHash-magnet";
  }
  // Strategy 3: Download .torrent file through Prowlarr (may return a magnet redirect!)
  else if (r.downloadUrl) {
    console.log(`[AutoGrab] Downloading via Prowlarr: ${r.downloadUrl.substring(0, 80)}...`);
    const result = await prowlarr.downloadFile(r.downloadUrl, r.indexerId);

    if (result?.type === "magnet") {
      // Prowlarr/indexer redirected to a magnet link (common with public trackers)
      console.log(`[AutoGrab] Got magnet link from download redirect`);
      await qbit.addTorrentByUrl(result.url, opts);
      usedMethod = "redirect-magnet";
    } else if (result?.type === "file" && result.data.length > 100) {
      await qbit.addTorrentByFile(result.data, `${r.title}.torrent`, opts);
      usedMethod = "torrent-file";
    } else {
      // Strategy 4: Use Prowlarr's native grab API
      console.log(`[AutoGrab] Download failed, trying Prowlarr-native grab`);
      const grabbed = await prowlarr.grabRelease(r);
      if (grabbed) {
        usedMethod = "prowlarr-native-grab";
      } else {
        throw new Error("All download methods failed: no magnet/hash, download failed, Prowlarr grab failed");
      }
    }
  } else {
    throw new Error("No download URL, magnet, or infoHash available");
  }

  // Verify the torrent actually appeared in qBittorrent (skip for Prowlarr-native grabs)
  if (usedMethod !== "prowlarr-native-grab") {
    await verifyTorrentAdded(qbit, r.title, category, r.infoHash);
  }

  await prisma.download.create({ data: { requestId, downloadType: "torrent", magnetUrl: r.magnetUrl || r.downloadUrl, torrentName: r.title, torrentHash: r.infoHash, status: "DOWNLOADING" } });
  await prisma.request.update({ where: { id: requestId }, data: { status: "DOWNLOADING" } });
  const via = usedMethod === "prowlarr-native-grab" ? "Prowlarr" : "qBittorrent";
  return { success: true, message: `Grabbed "${r.title}" from ${r.indexer} via ${via} (${usedMethod})`, torrentTitle: r.title, indexer: r.indexer };
}

async function grabUsenet(
  prowlarr: NonNullable<Awaited<ReturnType<typeof getCachedProwlarrClient>>>,
  sabnzbd: NonNullable<Awaited<ReturnType<typeof getCachedSABnzbdClient>>>,
  r: ProwlarrRelease, requestId: number, category: string, gameName: string,
): Promise<AutoGrabResult> {
  if (!r.downloadUrl) throw new Error("No download URL for NZB");

  const result = await prowlarr.downloadFile(r.downloadUrl, r.indexerId);
  const opts = { category: category || "rommseer", name: gameName };
  const nzoIds = result?.type === "file"
    ? await sabnzbd.addNzbByFile(result.data, `${r.title}.nzb`, opts)
    : await sabnzbd.addNzbByUrl(r.downloadUrl, opts);

  const nzbId = nzoIds?.[0] || null;
  await prisma.download.create({ data: { requestId, downloadType: "usenet", torrentName: r.title, nzbId, magnetUrl: r.downloadUrl, status: "DOWNLOADING" } });
  await prisma.request.update({ where: { id: requestId }, data: { status: "DOWNLOADING" } });
  return { success: true, message: `Grabbed "${r.title}" from ${r.indexer} via SABnzbd`, torrentTitle: r.title, indexer: r.indexer };
}
