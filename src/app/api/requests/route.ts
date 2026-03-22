import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { autoGrabForRequest } from "@/lib/autograb";
import { getSABnzbdClient } from "@/lib/sabnzbd";
import { getQBittorrentClient } from "@/lib/qbittorrent";
import { getRomMClient } from "@/lib/romm";
import { copyToRomMLibrary } from "@/lib/postcopy";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const isAdmin = session.user.role === "ADMIN";

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (!isAdmin) where.userId = session.user.id;

  // Check for failed downloads on DOWNLOADING requests and auto-retry
  if (isAdmin) {
    await syncAndRetryFailedDownloads();
  }

  const requests = await prisma.request.findMany({
    where,
    include: {
      game: { include: { platform: true } },
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(requests);
}

/** Sync download status from SABnzbd/qBit and auto-retry failed ones. */
async function syncAndRetryFailedDownloads() {
  const downloadingRequests = await prisma.request.findMany({
    where: { status: "DOWNLOADING" },
    select: { id: true },
  });
  if (!downloadingRequests.length) return;

  const downloads = await prisma.download.findMany({
    where: { requestId: { in: downloadingRequests.map((r) => r.id) }, status: "DOWNLOADING" },
  });
  if (!downloads.length) return;

  // Sync SABnzbd status
  const sabnzbd = await getSABnzbdClient();
  if (sabnzbd) {
    try {
      const [queue, history] = await Promise.all([sabnzbd.getQueue(), sabnzbd.getHistory(100)]);
      const qMap = new Map(queue.slots.map((s) => [s.nzo_id, s]));
      const hMap = new Map(history.slots.map((s) => [s.nzo_id, s]));

      for (const dl of downloads) {
        if (dl.downloadType !== "usenet" || !dl.nzbId) continue;
        const hs = hMap.get(dl.nzbId);
        const qs = qMap.get(dl.nzbId);
        if (hs) {
          console.log(`[Sync] SABnzbd history for ${dl.nzbId}: status="${hs.status}", fail_message="${hs.fail_message || ""}"`);
        }
        // SABnzbd uses "Failed" but also other failure statuses like "Aborted"
        const isFailed = hs && hs.status !== "Completed" && !qMap.has(dl.nzbId);
        if (isFailed && hs) {
          await prisma.download.update({ where: { id: dl.id }, data: { status: "FAILED", error: hs.fail_message || hs.status } });
          dl.status = "FAILED";
        } else if (hs?.status === "Completed") {
          await prisma.download.update({ where: { id: dl.id }, data: { status: "COMPLETED", progress: 100 } });
          dl.status = "COMPLETED";
          // Update request to AVAILABLE, copy ROM to library, then trigger scan
          await prisma.request.update({ where: { id: dl.requestId }, data: { status: "AVAILABLE" } });
          console.log(`[Sync] Request #${dl.requestId}: download completed, marked AVAILABLE`);
          copyAndScan(dl.requestId, dl.id);
        } else if (qs) {
          await prisma.download.update({ where: { id: dl.id }, data: { progress: Math.round(parseFloat(qs.percentage)) } });
        }
      }
    } catch (e) { console.error("SABnzbd sync:", e); }
  }

  // Sync qBittorrent status
  const qbit = await getQBittorrentClient();
  if (qbit) {
    try {
      const torrents = await qbit.getTorrents();
      const tMap = new Map(torrents.map((t) => [t.hash, t]));
      for (const dl of downloads) {
        if (dl.downloadType === "usenet" || !dl.torrentHash) continue;
        const t = tMap.get(dl.torrentHash);
        if (t && ["error", "missingFiles"].includes(t.state)) {
          await prisma.download.update({ where: { id: dl.id }, data: { status: "FAILED" } });
          dl.status = "FAILED";
        } else if (t && t.progress >= 1) {
          await prisma.download.update({ where: { id: dl.id }, data: { status: "COMPLETED", progress: 100 } });
          dl.status = "COMPLETED";
          // Update request to AVAILABLE, copy ROM to library, then trigger scan
          await prisma.request.update({ where: { id: dl.requestId }, data: { status: "AVAILABLE" } });
          console.log(`[Sync] Request #${dl.requestId}: torrent completed, marked AVAILABLE`);
          copyAndScan(dl.requestId, dl.id);
        }
      }
    } catch (e) { console.error("qBit sync:", e); }
  }

  // Auto-retry failed downloads
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.prowlarrAutoGrab) return;

  const failedIds = new Set<number>();
  for (const dl of downloads) {
    if (dl.status === "FAILED") failedIds.add(dl.requestId);
  }

  for (const rid of Array.from(failedIds)) {
    const count = await prisma.download.count({ where: { requestId: rid } });
    if (count >= 3) {
      console.log(`[AutoRetry] #${rid}: max retries (${count})`);
      await prisma.request.update({ where: { id: rid }, data: { status: "APPROVED" } });
      continue;
    }
    console.log(`[AutoRetry] #${rid}: retrying (${count + 1}/3)`);
    await prisma.request.update({ where: { id: rid }, data: { status: "APPROVED" } });
    autoGrabForRequest(rid).then((r) => console.log(`[AutoRetry] #${rid}:`, r.message)).catch((e) => console.error(`[AutoRetry] #${rid}:`, e));
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { gameId, comment } = body;

  if (!gameId) {
    return NextResponse.json(
      { error: "gameId is required" },
      { status: 400 }
    );
  }

  // Check if request already exists
  const existing = await prisma.request.findUnique({
    where: {
      userId_gameId: {
        userId: session.user.id,
        gameId: Number(gameId),
      },
    },
  });

  if (existing) {
    return NextResponse.json(
      { error: "You have already requested this game" },
      { status: 409 }
    );
  }

  // Check if auto-approve is enabled
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const shouldAutoApprove = settings?.autoApprove ?? false;

  const request = await prisma.request.create({
    data: {
      userId: session.user.id,
      gameId: Number(gameId),
      comment,
      status: shouldAutoApprove ? "APPROVED" : "PENDING",
    },
    include: {
      game: { include: { platform: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  });

  // If auto-approved and auto-grab is enabled, trigger auto-grab in the background
  if (shouldAutoApprove && settings?.prowlarrAutoGrab && settings?.prowlarrUrl) {
    autoGrabForRequest(request.id)
      .then((result) => {
        console.log(`[AutoGrab] Completed for auto-approved request ${request.id}:`, result.message);
      })
      .catch((err) => {
        console.error(`[AutoGrab] Error for auto-approved request ${request.id}:`, err);
      });
  }

  return NextResponse.json(request, { status: 201 });
}

/** Copy ROM files to RomM library and trigger a scan (non-blocking). */
function copyAndScan(requestId: number, downloadId: number) {
  copyToRomMLibrary(requestId, downloadId)
    .then(async (copied) => {
      if (copied) {
        console.log(`[PostCopy] Files copied for request #${requestId}, triggering RomM scan`);
      } else {
        console.log(`[PostCopy] No files copied for request #${requestId}, triggering RomM scan anyway`);
      }

      const req = await prisma.request.findUnique({
        where: { id: requestId },
        include: { game: { include: { platform: true } } },
      });
      if (!req) return;

      const romm = await getRomMClient();
      if (!romm) return;

      try {
        const platforms = await romm.getPlatforms();
        const match = platforms.find((p) =>
          p.name.toLowerCase() === req.game.platform.name.toLowerCase() ||
          p.slug.toLowerCase() === req.game.platform.name.toLowerCase().replace(/\s+/g, "-")
        );

        if (match) {
          console.log(`[RomM] Scanning platform "${match.name}" (id=${match.id}) for request #${requestId}`);
          await romm.scanPlatform(match.id);
        } else {
          console.log(`[RomM] No matching platform for "${req.game.platform.name}", triggering full scan`);
          await romm.scanAll();
        }
      } catch (e) {
        console.error(`[RomM] Scan trigger failed for request #${requestId}:`, e);
      }
    })
    .catch((e) => console.error(`[PostCopy] Error for request #${requestId}:`, e));
}
