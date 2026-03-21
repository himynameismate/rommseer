import { prisma } from "@/lib/db";
import { getProwlarrClient } from "@/lib/prowlarr";
import { getQBittorrentClient } from "@/lib/qbittorrent";

interface AutoGrabResult {
  success: boolean;
  message: string;
  torrentTitle?: string;
  indexer?: string;
}

/**
 * Automatically search Prowlarr for a ROM and send it to qBittorrent.
 * Called when an admin approves a request and auto-grab is enabled.
 */
export async function autoGrabForRequest(requestId: number): Promise<AutoGrabResult> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });

  if (!settings?.prowlarrAutoGrab) {
    return { success: false, message: "Auto-grab is not enabled" };
  }

  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: { game: { include: { platform: true } } },
  });

  if (!request) {
    return { success: false, message: "Request not found" };
  }

  // Get Prowlarr client
  const prowlarr = await getProwlarrClient();
  if (!prowlarr) {
    return { success: false, message: "Prowlarr not configured" };
  }

  // Get qBittorrent client
  const qbit = await getQBittorrentClient();
  if (!qbit) {
    return { success: false, message: "qBittorrent not configured" };
  }

  try {
    // Search for the best torrent
    const bestResult = await prowlarr.autoGrab(
      request.game.name,
      request.game.platform.name,
      {
        searchTemplate: settings.prowlarrSearchTemplate || undefined,
        minSeeders: settings.prowlarrMinSeeders,
        maxSizeMb: settings.prowlarrMaxSizeMb,
        preferredIndexers: settings.prowlarrPreferredIndexers,
      }
    );

    if (!bestResult) {
      console.log(`[AutoGrab] No suitable torrent found for "${request.game.name}" on ${request.game.platform.name}`);
      return {
        success: false,
        message: `No suitable torrent found for "${request.game.name}" on ${request.game.platform.name}`,
      };
    }

    console.log(`[AutoGrab] Best result: "${bestResult.title}" from ${bestResult.indexer}, seeders=${bestResult.seeders}, size=${bestResult.size}`);

    // Get the download URL (prefer magnet, fall back to download URL)
    const downloadLink = bestResult.magnetUrl || bestResult.downloadUrl;
    if (!downloadLink) {
      return {
        success: false,
        message: "Best result has no download or magnet URL",
      };
    }

    // Send to qBittorrent
    await qbit.addTorrentByUrl(downloadLink, {
      category: settings.qbitCategory || "rommseer",
      savepath: settings.qbitSavePath || undefined,
      tags: `rommseer,${request.game.name},auto-grab`,
    });

    // Create download record
    await prisma.download.create({
      data: {
        requestId,
        magnetUrl: downloadLink,
        torrentName: bestResult.title,
        torrentHash: bestResult.infoHash || null,
        status: "DOWNLOADING",
      },
    });

    // Update request status to DOWNLOADING
    await prisma.request.update({
      where: { id: requestId },
      data: { status: "DOWNLOADING" },
    });

    return {
      success: true,
      message: `Auto-grabbed "${bestResult.title}" from ${bestResult.indexer}`,
      torrentTitle: bestResult.title,
      indexer: bestResult.indexer,
    };
  } catch (error) {
    console.error("Auto-grab failed:", error);

    // Create a failed download record
    await prisma.download.create({
      data: {
        requestId,
        status: "FAILED",
        error: error instanceof Error ? error.message : "Auto-grab failed",
      },
    });

    return {
      success: false,
      message: error instanceof Error ? error.message : "Auto-grab failed",
    };
  }
}
