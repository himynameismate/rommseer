import { prisma } from "@/lib/db";
import { logger } from "@/lib/utils";
import { ProwlarrRelease } from "@/lib/prowlarr";
import { getCachedProwlarrClient, getCachedQBittorrentClient, getCachedSABnzbdClient } from "@/lib/clients";
import { searchAndDownloadFromIA } from "@/lib/archive-org";
import { copyAndScan } from "@/lib/postcopy";

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

// Track indexer failures to skip broken indexers (persisted in DB via IndexerHealth)
const INDEXER_FAIL_THRESHOLD = 3;
const INDEXER_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

export async function recordIndexerFailure(indexer: string): Promise<void> {
  const record = await prisma.indexerHealth.upsert({
    where: { indexer },
    create: { indexer, failureCount: 1, lastFailure: new Date() },
    update: { failureCount: { increment: 1 }, lastFailure: new Date() },
  });
  if (record.failureCount >= INDEXER_FAIL_THRESHOLD && !record.blockedUntil) {
    await prisma.indexerHealth.update({
      where: { indexer },
      data: { blockedUntil: new Date(Date.now() + INDEXER_COOLDOWN_MS) },
    });
    logger.log(`[AutoGrab] Indexer "${indexer}" blocked after ${record.failureCount} failures (30 min cooldown)`);
  }
}

export async function recordIndexerSuccess(indexer: string): Promise<void> {
  await prisma.indexerHealth.deleteMany({ where: { indexer } });
}

export async function isIndexerBlocked(indexer: string): Promise<boolean> {
  const record = await prisma.indexerHealth.findUnique({ where: { indexer } });
  if (!record || record.failureCount < INDEXER_FAIL_THRESHOLD || !record.blockedUntil) return false;
  if (new Date() > record.blockedUntil) {
    logger.log(`[AutoGrab] Indexer "${indexer}" cooldown expired, retrying`);
    await prisma.indexerHealth.delete({ where: { indexer } });
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

  // Parse download priority order (default: torrent → usenet → ia)
  const priority = (settings.downloadPriority || "torrent,usenet,ia")
    .split(",").map((s) => s.trim()).filter(Boolean) as ("torrent" | "usenet" | "ia")[];
  const torrentEnabled = settings.torrentEnabled !== false;
  const usenetEnabled = settings.usenetEnabled !== false;
  const archiveOrgEnabled = settings.archiveOrgEnabled === true;

  const anySourceEnabled = (torrentEnabled || usenetEnabled || archiveOrgEnabled);
  if (!anySourceEnabled) return { success: false, message: "All download sources are disabled" };

  const [prowlarr, qbit, sabnzbd] = await Promise.all([
    getCachedProwlarrClient(), getCachedQBittorrentClient(), getCachedSABnzbdClient(),
  ]);

  try {
    // Exclude previously failed titles (normalized to catch minor punctuation differences)
    const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const failed = await prisma.download.findMany({ where: { requestId, status: "FAILED" }, select: { torrentName: true } });
    const failedTitles = new Set(failed.map((d) => normTitle(d.torrentName || "")).filter(Boolean));
    if (failedTitles.size) logger.log(`[AutoGrab] Excluding ${failedTitles.size} previously failed results`);

    // ── Prowlarr search (fetch once, bucket by protocol) ────────────
    let torrentResults: ProwlarrRelease[] = [];
    let usenetResults: ProwlarrRelease[] = [];
    const skipFailing = settings.prowlarrSkipFailingIndexers !== false;

    if (prowlarr) {
      const allResults = await prowlarr.searchForRom(
        request.game.name, request.game.platform.name,
        settings.prowlarrSearchTemplate || undefined, settings.prowlarrMinSeeders, settings.prowlarrMaxSizeMb,
      );
      let results = allResults.filter((r) => !failedTitles.has(normTitle(r.title)));

      // Apply indexer blocking
      if (skipFailing) {
        const blockedStatuses = await Promise.all(results.map((r) => isIndexerBlocked(r.indexer)));
        const blocked = results.filter((_, i) => blockedStatuses[i]);
        results = results.filter((_, i) => !blockedStatuses[i]);
        if (blocked.length) {
          logger.log(`[AutoGrab] Skipping ${blocked.length} results from blocked indexers: ${Array.from(new Set(blocked.map((r) => r.indexer))).join(", ")}`);
        }
      }

      // Boost preferred indexers
      if (settings.prowlarrPreferredIndexers) {
        const pref = settings.prowlarrPreferredIndexers.split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
        if (pref.length) results.sort((a, b) => +pref.includes(b.indexer.toLowerCase()) - +pref.includes(a.indexer.toLowerCase()));
      }

      // Dry-run: log and return early
      if (settings.prowlarrDryRun && results.length > 0) {
        const top = results.slice(0, 5);
        for (const r of top) {
          logger.log(`[DRY RUN] Would grab: "${r.title}" (${r.protocol}, ${r.indexer}, seeders: ${r.seeders ?? "n/a"})`);
        }
        const best = top[0];
        return { success: true, message: `[DRY RUN] Would grab: "${best.title}" from ${best.indexer} (${results.length} results)`, torrentTitle: best.title, indexer: best.indexer };
      }

      torrentResults = results.filter((r) => r.protocol !== "usenet");
      usenetResults = results.filter((r) => r.protocol === "usenet");
      logger.log(`[AutoGrab] Prowlarr: ${torrentResults.length} torrent + ${usenetResults.length} usenet results`);
    } else {
      logger.log(`[AutoGrab] Prowlarr not configured`);
    }

    if (settings.prowlarrDryRun && archiveOrgEnabled) {
      logger.log(`[DRY RUN] Would also try Internet Archive for "${request.game.name}"`);
      return { success: true, message: `[DRY RUN] Would try Internet Archive for "${request.game.name}"` };
    }

    // ── Try sources in priority order ────────────────────────────────
    logger.log(`[AutoGrab] Priority order: ${priority.join(" → ")}`);

    for (const source of priority) {
      if (source === "torrent") {
        if (!torrentEnabled) { logger.log(`[AutoGrab] Skipping torrent (disabled)`); continue; }
        if (!qbit) { logger.log(`[AutoGrab] Skipping torrent (qBittorrent not configured)`); continue; }
        if (torrentResults.length === 0) { logger.log(`[AutoGrab] Skipping torrent (no results)`); continue; }

        logger.log(`[AutoGrab] Trying ${torrentResults.length} torrent result(s)...`);
        for (let i = 0; i < torrentResults.length && i < 5; i++) {
          const r = torrentResults[i];
          logger.log(`[AutoGrab] Torrent try ${i + 1}: "${r.title}" (${r.indexer})`);
          try {
            const result = await grabTorrent(prowlarr!, qbit, r, requestId, settings, request.game.name);
            if (skipFailing) await recordIndexerSuccess(r.indexer);
            return result;
          } catch (e) {
            const msg = e instanceof Error ? e.message : "Failed";
            logger.log(`[AutoGrab] Torrent ${i + 1} failed: ${msg}`);
            if (skipFailing) await recordIndexerFailure(r.indexer);
            if (msg.includes("no longer exists") || msg.includes("Foreign key")) {
              return { success: false, message: "Request was deleted" };
            }
          }
        }
        logger.log(`[AutoGrab] All torrent results failed, trying next source`);

      } else if (source === "usenet") {
        if (!usenetEnabled) { logger.log(`[AutoGrab] Skipping usenet (disabled)`); continue; }
        if (!sabnzbd) { logger.log(`[AutoGrab] Skipping usenet (SABnzbd not configured)`); continue; }
        if (usenetResults.length === 0) { logger.log(`[AutoGrab] Skipping usenet (no results)`); continue; }

        logger.log(`[AutoGrab] Trying ${usenetResults.length} usenet result(s)...`);
        for (let i = 0; i < usenetResults.length && i < 5; i++) {
          const r = usenetResults[i];
          logger.log(`[AutoGrab] Usenet try ${i + 1}: "${r.title}" (${r.indexer})`);
          try {
            const result = await grabUsenet(prowlarr!, sabnzbd, r, requestId, settings.sabnzbdCategory, request.game.name);
            if (skipFailing) await recordIndexerSuccess(r.indexer);
            return result;
          } catch (e) {
            const msg = e instanceof Error ? e.message : "Failed";
            logger.log(`[AutoGrab] Usenet ${i + 1} failed: ${msg}`);
            if (skipFailing) await recordIndexerFailure(r.indexer);
            if (msg.includes("no longer exists") || msg.includes("Foreign key")) {
              return { success: false, message: "Request was deleted" };
            }
          }
        }
        logger.log(`[AutoGrab] All usenet results failed, trying next source`);

      } else if (source === "ia") {
        if (!archiveOrgEnabled) { logger.log(`[AutoGrab] Skipping Internet Archive (disabled)`); continue; }

        logger.log(`[AutoGrab] Trying Internet Archive for "${request.game.name}" (${request.game.platform.name})`);
        const iaResult = await searchAndDownloadFromIA(
          request.game.name, request.game.platform.name, settings.prowlarrMaxSizeMb,
        );

        if (iaResult) {
          await prisma.download.create({
            data: {
              requestId, downloadType: "direct",
              torrentName: iaResult.result.fileName,
              magnetUrl: iaResult.result.filePath,
              indexer: "Internet Archive",
              status: "COMPLETED", progress: 100,
            },
          });
          await prisma.request.update({ where: { id: requestId }, data: { status: "DOWNLOADING" } });
          const dl = await prisma.download.findFirst({
            where: { requestId, downloadType: "direct", status: "COMPLETED" },
            orderBy: { createdAt: "desc" },
          });
          if (dl) copyAndScan(requestId, dl.id);
          return {
            success: true,
            message: `Downloaded "${iaResult.result.fileName}" from Internet Archive (${iaResult.itemTitle})`,
            torrentTitle: iaResult.result.fileName,
            indexer: "Internet Archive",
          };
        }
        logger.log(`[AutoGrab] Internet Archive had no suitable results`);
      }
    }

    return { success: false, message: `No results from any enabled source for "${request.game.name}"` };
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
  if (match) { logger.log(`[AutoGrab] Verified torrent in qBittorrent (${match})`); return; }

  // Slower retry after 5s more (for magnets needing DHT resolution)
  await new Promise((r) => setTimeout(r, 5000));
  const all = await qbit.getTorrents();
  match = findInTorrents(all, normalized, hashLower);
  if (match) { logger.log(`[AutoGrab] Verified torrent in qBittorrent (${match}, retry)`); return; }

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
      logger.log(`[AutoGrab] Using magnet URL: ${r.magnetUrl!.substring(0, 120)}...`);
      await qbit.addTorrentByUrl(r.magnetUrl!, opts);
    }});
  }
  if (r.downloadUrl) {
    strategies.push({ name: "prowlarr-download", fn: async () => {
      logger.log(`[AutoGrab] Downloading via Prowlarr: ${r.downloadUrl!.replace(/([?&])(apikey|api_key)=[^&]*/gi, "$1$2=***").substring(0, 80)}...`);
      const result = await prowlarr.downloadFile(r.downloadUrl!, r.indexerId);
      if (result?.type === "magnet") {
        logger.log(`[AutoGrab] Got magnet link from download redirect`);
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
      logger.log(`[AutoGrab] Constructed magnet from infoHash: ${r.infoHash}`);
      await qbit.addTorrentByUrl(magnet, opts);
    }});
  }
  // Also try passing the Prowlarr proxy URL directly to qBit (works for some indexers)
  if (r.magnetUrl && !r.magnetUrl.startsWith("magnet:")) {
    strategies.push({ name: "proxy-url", fn: async () => {
      logger.log(`[AutoGrab] Trying Prowlarr proxy URL directly`);
      await qbit.addTorrentByUrl(r.magnetUrl!, opts);
    }});
  }
  if (r.downloadUrl) {
    strategies.push({ name: "prowlarr-native-grab", fn: async () => {
      logger.log(`[AutoGrab] Trying Prowlarr-native grab`);
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
      logger.log(`[AutoGrab] Strategy ${strategy.name} failed: ${msg}`);
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
