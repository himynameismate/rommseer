import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getCachedQBittorrentClient, getCachedSABnzbdClient, getCachedProwlarrClient } from "@/lib/clients";
import { syncAndRetryDownloads } from "@/lib/sync";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, Number(searchParams.get("page") || "1"));
  const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || "50")));

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
    skip: (page - 1) * limit,
    take: limit,
  });

  // Fire-and-forget sync (non-blocking, Issue #14)
  // Pass useRequestInclude so sync uses dl.request instead of re-fetching (Issue #3)
  syncAndRetryDownloads(
    downloads.map((dl) => ({
      id: dl.id,
      requestId: dl.requestId,
      downloadType: dl.downloadType,
      nzbId: dl.nzbId,
      torrentHash: dl.torrentHash,
      status: dl.status,
      progress: dl.progress,
      request: dl.request,
    })),
    { useRequestInclude: true }
  ).catch((e) => console.error("[Sync] Background sync error:", e));

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
      const sabnzbd = await getCachedSABnzbdClient();
      if (!sabnzbd) return NextResponse.json({ error: "SABnzbd not configured" }, { status: 400 });
      const prowlarr = await getCachedProwlarrClient();
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
      const qbit = await getCachedQBittorrentClient();
      if (!qbit) return NextResponse.json({ error: "qBittorrent not configured" }, { status: 400 });
      const opts = { category: settings?.qbitCategory || "rommseer", savepath: settings?.qbitSavePath || undefined, tags: `rommseer,${request.game.name}` };

      if (magnetUrl.startsWith("magnet:")) {
        await qbit.addTorrentByUrl(magnetUrl, opts);
      } else {
        const prowlarr = await getCachedProwlarrClient();
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
    await prisma.download.create({
      data: { requestId, downloadType: isUsenet ? "usenet" : "torrent", magnetUrl, status: "FAILED", error: error instanceof Error ? error.message : "Unknown error" },
    });
    return NextResponse.json({ error: "Failed to add download" }, { status: 500 });
  }
}
