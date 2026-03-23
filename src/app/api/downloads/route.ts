import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getQBittorrentClient } from "@/lib/qbittorrent";
import { getProwlarrClient } from "@/lib/prowlarr";
import { getSABnzbdClient } from "@/lib/sabnzbd";
import { autoGrabForRequest } from "@/lib/autograb";
import { getRomMClient } from "@/lib/romm";
import { copyToRomMLibrary } from "@/lib/postcopy";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const downloads = await prisma.download.findMany({
    include: {
      request: {
        include: {
          game: { include: { platform: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Sync torrent status from qBittorrent
  const qbit = await getQBittorrentClient();
  if (qbit) {
    try {
      const torrents = await qbit.getTorrents();
      const tMap = new Map(torrents.map((t) => [t.hash, t]));

      for (const dl of downloads) {
        if (dl.downloadType === "usenet" || !dl.torrentHash || !tMap.has(dl.torrentHash)) continue;
        const t = tMap.get(dl.torrentHash)!;
        const progress = Math.round(t.progress * 100);
        const status = t.progress >= 1 ? "COMPLETED"
          : ["error", "missingFiles"].includes(t.state) ? "FAILED"
          : ["downloading", "stalledDL", "forcedDL", "metaDL"].includes(t.state) ? "DOWNLOADING"
          : dl.status;

        if (progress !== Math.round(dl.progress) || status !== dl.status) {
          await prisma.download.update({ where: { id: dl.id }, data: { progress, status } });
          if (status === "COMPLETED" && dl.status !== "COMPLETED") {
            await prisma.request.update({ where: { id: dl.requestId }, data: { status: "AVAILABLE" } });
            copyAndScan(dl.requestId, dl.id);
          }
          dl.progress = progress;
          dl.status = status;
        }
      }
    } catch (e) { console.error("Torrent sync error:", e); }
  }

  // Sync usenet status from SABnzbd
  const sabnzbd = await getSABnzbdClient();
  if (sabnzbd) {
    try {
      const [queue, history] = await Promise.all([sabnzbd.getQueue(), sabnzbd.getHistory(100)]);
      const qMap = new Map(queue.slots.map((s) => [s.nzo_id, s]));
      const hMap = new Map(history.slots.map((s) => [s.nzo_id, s]));

      for (const dl of downloads) {
        if (dl.downloadType !== "usenet" || !dl.nzbId) continue;
        const qs = qMap.get(dl.nzbId), hs = hMap.get(dl.nzbId);
        let progress = dl.progress, status = dl.status;

        if (qs) {
          progress = Math.round(parseFloat(qs.percentage));
          status = "DOWNLOADING";
        } else if (hs) {
          if (hs.status === "Completed") {
            progress = 100;
            status = "COMPLETED";
          } else {
            // Any non-Completed history status is a failure (Failed, Aborted, etc.)
            status = "FAILED";
          }
        }

        if (progress !== Math.round(dl.progress) || status !== dl.status) {
          await prisma.download.update({ where: { id: dl.id }, data: { progress, status } });
          if (status === "COMPLETED" && dl.status !== "COMPLETED") {
            await prisma.request.update({ where: { id: dl.requestId }, data: { status: "AVAILABLE" } });
            copyAndScan(dl.requestId, dl.id);
          }
          dl.progress = progress;
          dl.status = status;
        }
      }
    } catch (e) { console.error("SABnzbd sync error:", e); }
  }

  // Auto-retry failed downloads (max 3 attempts per request)
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (settings?.prowlarrAutoGrab) {
    const retryIds = new Set<number>();
    for (const dl of downloads) {
      if (dl.status === "FAILED" && dl.requestId) {
        const req = await prisma.request.findUnique({ where: { id: dl.requestId } });
        if (req?.status === "DOWNLOADING") retryIds.add(dl.requestId);
      }
    }

    for (const rid of Array.from(retryIds)) {
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

  return NextResponse.json(downloads);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { requestId, magnetUrl, protocol } = await req.json();
  if (!requestId || !magnetUrl) {
    return NextResponse.json({ error: "requestId and magnetUrl required" }, { status: 400 });
  }

  const request = await prisma.request.findUnique({ where: { id: requestId }, include: { game: { include: { platform: true } } } });
  if (!request) return NextResponse.json({ error: "Request not found" }, { status: 404 });

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const isUsenet = protocol === "usenet";

  try {
    let nzbId: string | null = null;

    if (isUsenet) {
      const sabnzbd = await getSABnzbdClient();
      if (!sabnzbd) return NextResponse.json({ error: "SABnzbd not configured" }, { status: 400 });
      const prowlarr = await getProwlarrClient();
      const opts = { category: settings?.sabnzbdCategory || "rommseer", name: request.game.name };

      if (prowlarr) {
        const file = await prowlarr.downloadFile(magnetUrl);
        const ids = file ? await sabnzbd.addNzbByFile(file, "download.nzb", opts) : await sabnzbd.addNzbByUrl(magnetUrl, opts);
        nzbId = ids?.[0] || null;
      } else {
        const ids = await sabnzbd.addNzbByUrl(magnetUrl, opts);
        nzbId = ids?.[0] || null;
      }
    } else {
      const qbit = await getQBittorrentClient();
      if (!qbit) return NextResponse.json({ error: "qBittorrent not configured" }, { status: 400 });
      const opts = { category: settings?.qbitCategory || "rommseer", savepath: settings?.qbitSavePath || undefined, tags: `rommseer,${request.game.name}` };

      if (magnetUrl.startsWith("magnet:")) {
        await qbit.addTorrentByUrl(magnetUrl, opts);
      } else {
        const prowlarr = await getProwlarrClient();
        const file = prowlarr ? await prowlarr.downloadFile(magnetUrl) : null;
        if (file) await qbit.addTorrentByFile(file, "download.torrent", opts);
        else await qbit.addTorrentByUrl(magnetUrl, opts);
      }
    }

    const download = await prisma.download.create({
      data: { requestId, downloadType: isUsenet ? "usenet" : "torrent", magnetUrl, nzbId, status: "DOWNLOADING" },
      include: { request: { include: { game: { include: { platform: true } }, user: { select: { id: true, name: true, email: true } } } } },
    });
    await prisma.request.update({ where: { id: requestId }, data: { status: "DOWNLOADING" } });
    return NextResponse.json(download);
  } catch (error) {
    console.error("Download failed:", error instanceof Error ? error.message : error);
    const download = await prisma.download.create({
      data: { requestId, downloadType: isUsenet ? "usenet" : "torrent", magnetUrl, status: "FAILED", error: error instanceof Error ? error.message : "Unknown error" },
    });
    return NextResponse.json({ error: "Failed to add download" }, { status: 500 });
  }
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
          console.log(`[RomM] Scanning platform "${match.name}" for request #${requestId}`);
          await romm.scanPlatform(match.id);
        } else {
          console.log(`[RomM] No matching platform for "${req.game.platform.name}", full scan`);
          await romm.scanAll();
        }
      } catch (e) {
        console.error(`[RomM] Scan failed for request #${requestId}:`, e);
      }
    })
    .catch((e) => console.error(`[PostCopy] Error for request #${requestId}:`, e));
}
