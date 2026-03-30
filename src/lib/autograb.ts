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
// Track in-progress grabs to prevent concurrent grabs for the same request
const activeGrabs = new Set<number>();

// Track indexer failures to skip broken indexers
// After INDEXER_FAIL_THRESHOLD consecutive download failures, skip results from that indexer
// for INDEXER_COOLDOWN_MS before trying again
const INDEXER_FAIL_THRESHOLD = 3;
const INDEXER_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const indexerFailures = new Map<string, { count: number; lastFailure: number }>();

export function recordIndexerFailure(indexer: string): void {
  // Prune entries older than cooldown to prevent unbounded growth
  if (indexerFailures.size > 50) {
    const now = Date.now();
    Array.from(indexerFailures.entries()).forEach(([key, val]) => {
      if (now - val.lastFailure > INDEXER_COOLDOWN_MS * 2) indexerFailures.delete(key);
    });
  }
  const existing = indexerFailures.get(indexer) || { count: 0, lastFailure: 0 };
  existing.count++;
  existing.lastFailure = Date.now();
  indexerFailures.set(indexer, existing);
  if (existing.count === INDEXER_FAIL_THRESHOLD) {
    console.log(`[AutoGrab] Indexer "${indexer}" blocked after ${existing.count} failures (30 min cooldown)`);
  }
}

function recordIndexerSuccess(indexer: string): void {
  indexerFailures.delete(indexer);
}

function isIndexerBlocked(indexer: string): boolean {
  const record = indexerFailures.get(indexer);
  if (!record || record.count < INDEXER_FAIL_THRESHOLD) return false;
  // Reset after cooldown
  if (Date.now() - record.lastFailure > INDEXER_COOLDOWN_MS) {
    console.log(`[AutoGrab] Indexer "${indexer}" cooldown expired, retrying`);
    indexerFailures.delete(indexer);
    return false;
  }
  return true;
}

export async function autoGrabForRequest(requestId: number): Promise<AutoGrabResult> {
  // Prevent concurrent auto-grabs for the same request (race condition guard)
  if (activeGrabs.has(requestId)) return { success: false, message: "Already grabbing" };
  activeGrabs.add(requestId);
  try {
    return await _autoGrabForRequest(requestId);
  } finally {
    activeGrabs.delete(requestId);
  }
}

async function _autoGrabForRequest(requestId: number): Promise<AutoGrabResult> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.prowlarrAutoGrab) return { success: false, message: "Auto-grab not enabled" };

  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: { game: { include: { platform: true } }, downloads: { select: { id: true } } },
  });
  if (!request) return { success: false, message: "Request not found" };
  if (request.status === "DOWNLOADING") {
    return { success: false, message: "Already downloading" };
  }
  // Stop retrying after too many failed attempts
  if (request.downloads.length >= 5) {
    return { success: false, message: `Max retries reached (${request.downloads.length} downloads)` };
  }

  const [prowlarr, qbit, sabnzbd] = await Promise.all([
    getCachedProwlarrClient(), getCachedQBittorrentClient(), getCachedSABnzbdClient(),
  ]);
  if (!prowlarr) return { success: false, message: "Prowlarr not configured" };
  if (!qbit && !sabnzbd) return { success: false, message: "No download client configured" };

  try {
    // Exclude previously failed titles (normalized to catch minor punctuation differences)
    const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const failed = await prisma.download.findMany({ where: { requestId, status: "FAILED" }, select: { torrentName: true } });
    const failedTitles = new Set(failed.map((d) => normTitle(d.torrentName || "")).filter(Boolean));
    if (failedTitles.size) console.log(`[AutoGrab] Excluding ${failedTitles.size} previously failed results`);

    const allResults = await prowlarr.searchForRom(
      request.game.name, request.game.platform.name,
      settings.prowlarrSearchTemplate || undefined, settings.prowlarrMinSeeders, settings.prowlarrMaxSizeMb,
    );
    const results = allResults.filter((r) => !failedTitles.has(normTitle(r.title)));

    if (!results.length) {
      const msg = failedTitles.size ? `No new results (${failedTitles.size} failed excluded)` : `No results for "${request.game.name}"`;
      return { success: false, message: msg };
    }

    // Boost preferred indexers
    if (settings.prowlarrPreferredIndexers) {
      const pref = settings.prowlarrPreferredIndexers.split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
      if (pref.length) results.sort((a, b) => +pref.includes(b.indexer.toLowerCase()) - +pref.includes(a.indexer.toLowerCase()));
    }

    // Filter out results from blocked indexers (if enabled)
    const skipFailing = settings.prowlarrSkipFailingIndexers !== false; // default true
    const blocked = skipFailing ? results.filter((r) => isIndexerBlocked(r.indexer)) : [];
    const viable = skipFailing ? results.filter((r) => !isIndexerBlocked(r.indexer)) : results;
    const blockedIndexerNames = Array.from(new Set(blocked.map((r) => r.indexer))).join(", ");
    if (blocked.length) console.log(`[AutoGrab] Skipping ${blocked.length} results from blocked indexers: ${blockedIndexerNames}`);
    if (!viable.length && blocked.length) {
      return { success: false, message: `All ${results.length} results from blocked indexers (${blockedIndexerNames})` };
    }

    // Try up to 5 results
    let lastErr = "";
    let tried = 0;
    for (let i = 0; i < viable.length && tried < 5; i++) {
      const r = viable[i];
      tried++;
      console.log(`[AutoGrab] Try ${tried}: "${r.title}" (${r.protocol}, ${r.indexer}) [magnet:${!!r.magnetUrl}, hash:${!!r.infoHash}, url:${!!r.downloadUrl}]`);
      try {
        let result: AutoGrabResult;
        if (r.protocol === "usenet") {
          if (!sabnzbd) { lastErr = "SABnzbd not configured"; continue; }
          result = await grabUsenet(prowlarr, sabnzbd, r, requestId, settings.sabnzbdCategory, request.game.name);
        } else {
          if (!qbit) { lastErr = "qBittorrent not configured"; continue; }
          result = await grabTorrent(prowlarr, qbit, r, requestId, settings, request.game.name);
        }
        if (skipFailing) recordIndexerSuccess(r.indexer);
        return result;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : "Download failed";
        console.log(`[AutoGrab] Result ${tried} failed: ${lastErr}`);
        if (skipFailing) recordIndexerFailure(r.indexer);
        // If request was deleted mid-grab, stop immediately
        if (lastErr.includes("no longer exists") || lastErr.includes("Foreign key")) {
          return { success: false, message: "Request was deleted" };
        }
      }
    }
    return { success: false, message: `All results failed. Last: ${lastErr}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Auto-grab failed";
    // Don't try to create a download record if the request was deleted
    if (!msg.includes("no longer exists") && !msg.includes("Foreign key")) {
      try { await prisma.download.create({ data: { requestId, status: "FAILED", error: msg } }); } catch { /* request may have been deleted */ }
    }
    return { success: false, message: msg };
  }
}

/** Check if torrent exists in a list by hash, title, or recent add time */
function findInTorrents(
  torrents: { hash: string; name: string; added_on: number }[],
  normalized: string, hashLower: string | undefined,
): string | null {
  if (hashLower && torrents.some((t) => t.hash.toLowerCase() === hashLower)) return "hash";
  if (torrents.some((t) => {
    const n = t.name.toLowerCase();
    return n.includes(normalized) || normalized.includes(n);
  })) return "title";
  const now = Math.floor(Date.now() / 1000);
  if (torrents.find((t) => now - t.added_on < 30)) return "recent";
  return null;
}

/** Wait briefly then check if a torrent actually appeared in qBittorrent.
 *  Uses adaptive timing: quick 2s check first, then 5s retry if needed. */
async function verifyTorrentAdded(
  qbit: NonNullable<Awaited<ReturnType<typeof getCachedQBittorrentClient>>>,
  title: string, category: string, infoHash?: string | null,
): Promise<void> {
  const normalized = title.toLowerCase();
  const hashLower = infoHash?.toLowerCase();

  // Quick check after 2s (catches most successful adds)
  await new Promise((r) => setTimeout(r, 2000));
  const torrents = await qbit.getTorrents(undefined, category);
  let match = findInTorrents(torrents, normalized, hashLower);
  if (match) { console.log(`[AutoGrab] Verified torrent in qBittorrent (${match})`); return; }

  // Slower retry after 5s more (for magnets needing DHT resolution)
  await new Promise((r) => setTimeout(r, 5000));
  const all = await qbit.getTorrents();
  match = findInTorrents(all, normalized, hashLower);
  if (match) { console.log(`[AutoGrab] Verified torrent in qBittorrent (${match}, retry)`); return; }

  throw new Error("Torrent was not actually added to qBittorrent (silent failure)");
}

async function grabTorrent(
  prowlarr: NonNullable<Awaited<ReturnType<typeof getCachedProwlarrClient>>>,
  qbit: NonNullable<Awaited<ReturnType<typeof getCachedQBittorrentClient>>>,
  r: ProwlarrRelease, requestId: number,
  settings: { qbitCategory: string; qbitSavePath: string }, gameName: string,
): Promise<AutoGrabResult> {
  // Re-verify request still exists before adding anything to download client
  const reqCheck = await prisma.request.findUnique({ where: { id: requestId }, select: { id: true } });
  if (!reqCheck) throw new Error("Request no longer exists (deleted?)");

  const category = settings.qbitCategory || "rommseer";
  const opts = { category, savepath: settings.qbitSavePath || undefined, tags: `rommseer,${gameName},auto-grab` };
  let usedMethod = "";
  const errors: string[] = [];

  // Build a list of strategies to try, in order of preference.
  // Priority: real magnet → .torrent file (has web seeds) → constructed magnet → native grab
  // Prowlarr-download comes before infoHash-magnet so indexers that rely on web seeds
  // (e.g. Internet Archive) get the .torrent file with web seed URLs, not a bare magnet.
  const strategies: { name: string; fn: () => Promise<void> }[] = [];

  // Only add real magnet: URLs as the magnet strategy (not Prowlarr proxy URLs)
  if (r.magnetUrl?.startsWith("magnet:")) {
    strategies.push({ name: "magnet", fn: async () => {
      console.log(`[AutoGrab] Using magnet URL: ${r.magnetUrl!.substring(0, 120)}...`);
      await qbit.addTorrentByUrl(r.magnetUrl!, opts);
    }});
  }
  if (r.downloadUrl) {
    strategies.push({ name: "prowlarr-download", fn: async () => {
      console.log(`[AutoGrab] Downloading via Prowlarr: ${r.downloadUrl!.replace(/([?&])(apikey|api_key)=[^&]*/gi, "$1$2=***").substring(0, 80)}...`);
      const result = await prowlarr.downloadFile(r.downloadUrl!, r.indexerId);
      if (result?.type === "magnet") {
        console.log(`[AutoGrab] Got magnet link from download redirect`);
        await qbit.addTorrentByUrl(result.url, opts);
        usedMethod = "redirect-magnet";
      } else if (result?.type === "file" && result.data.length > 100) {
        await qbit.addTorrentByFile(result.data, `${r.title}.torrent`, opts);
        usedMethod = "torrent-file";
      } else {
        throw new Error("Download returned no usable data");
      }
    }});
  }
  // Fallback: construct magnet from infoHash (no web seeds — last resort for torrent indexers)
  if (r.infoHash) {
    strategies.push({ name: "infoHash-magnet", fn: async () => {
      const magnet = `magnet:?xt=urn:btih:${r.infoHash}&dn=${encodeURIComponent(r.title)}`;
      console.log(`[AutoGrab] Constructed magnet from infoHash: ${r.infoHash}`);
      await qbit.addTorrentByUrl(magnet, opts);
    }});
  }
  // Also try passing the Prowlarr proxy URL directly to qBit (works for some indexers)
  if (r.magnetUrl && !r.magnetUrl.startsWith("magnet:")) {
    strategies.push({ name: "proxy-url", fn: async () => {
      console.log(`[AutoGrab] Trying Prowlarr proxy URL directly`);
      await qbit.addTorrentByUrl(r.magnetUrl!, opts);
    }});
  }
  if (r.downloadUrl) {
    strategies.push({ name: "prowlarr-native-grab", fn: async () => {
      console.log(`[AutoGrab] Trying Prowlarr-native grab`);
      const grabbed = await prowlarr.grabRelease(r);
      if (!grabbed) throw new Error("Prowlarr grab failed");
    }});
  }

  if (!strategies.length) {
    throw new Error("No download URL, magnet, or infoHash available");
  }

  for (const strategy of strategies) {
    try {
      await strategy.fn();
      if (!usedMethod) usedMethod = strategy.name;

      // Verify the torrent actually appeared (skip for Prowlarr-native grabs)
      if (usedMethod !== "prowlarr-native-grab") {
        await verifyTorrentAdded(qbit, r.title, category, r.infoHash);
      }

      // Success!
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed";
      console.log(`[AutoGrab] Strategy ${strategy.name} failed: ${msg}`);
      errors.push(`${strategy.name}: ${msg}`);
      usedMethod = "";
    }
  }

  if (!usedMethod) {
    throw new Error(`All download strategies failed: ${errors.join("; ")}`);
  }

  await prisma.download.create({ data: { requestId, downloadType: "torrent", magnetUrl: r.magnetUrl || r.downloadUrl, torrentName: r.title, torrentHash: r.infoHash, indexer: r.indexer, status: "DOWNLOADING" } });
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
  await prisma.download.create({ data: { requestId, downloadType: "usenet", torrentName: r.title, nzbId, magnetUrl: r.downloadUrl, indexer: r.indexer, status: "DOWNLOADING" } });
  await prisma.request.update({ where: { id: requestId }, data: { status: "DOWNLOADING" } });
  return { success: true, message: `Grabbed "${r.title}" from ${r.indexer} via SABnzbd`, torrentTitle: r.title, indexer: r.indexer };
}
