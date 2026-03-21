import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getQBittorrentClient } from "@/lib/qbittorrent";

// GET /api/downloads - List downloads with torrent status
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

  // Try to update progress from qBittorrent
  const qbit = await getQBittorrentClient();
  if (qbit) {
    try {
      const torrents = await qbit.getTorrents();
      const torrentMap = new Map(torrents.map((t) => [t.hash, t]));

      for (const download of downloads) {
        if (download.torrentHash && torrentMap.has(download.torrentHash)) {
          const torrent = torrentMap.get(download.torrentHash)!;
          const progress = Math.round(torrent.progress * 100);
          let status = download.status;

          if (torrent.progress >= 1) {
            status = "COMPLETED";
          } else if (
            torrent.state === "downloading" ||
            torrent.state === "stalledDL" ||
            torrent.state === "forcedDL" ||
            torrent.state === "metaDL"
          ) {
            status = "DOWNLOADING";
          } else if (
            torrent.state === "error" ||
            torrent.state === "missingFiles"
          ) {
            status = "FAILED";
          }

          // Update in DB if changed
          if (
            progress !== Math.round(download.progress) ||
            status !== download.status
          ) {
            await prisma.download.update({
              where: { id: download.id },
              data: { progress, status },
            });
            download.progress = progress;
            download.status = status;
          }
        }
      }
    } catch (error) {
      console.error("Failed to sync torrent status:", error);
    }
  }

  return NextResponse.json(downloads);
}

// POST /api/downloads - Add a torrent for a request
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { requestId, magnetUrl } = body;

  if (!requestId || !magnetUrl) {
    return NextResponse.json(
      { error: "requestId and magnetUrl are required" },
      { status: 400 }
    );
  }

  // Verify request exists
  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: { game: { include: { platform: true } } },
  });

  if (!request) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const qbit = await getQBittorrentClient();

  if (!qbit) {
    return NextResponse.json(
      { error: "qBittorrent not configured" },
      { status: 400 }
    );
  }

  try {
    // Add torrent to qBittorrent
    await qbit.addTorrentByUrl(magnetUrl, {
      category: settings?.qbitCategory || "rommseer",
      savepath: settings?.qbitSavePath || undefined,
      tags: `rommseer,${request.game.name}`,
    });

    // Create download record
    const download = await prisma.download.create({
      data: {
        requestId,
        magnetUrl,
        status: "DOWNLOADING",
      },
      include: {
        request: {
          include: {
            game: { include: { platform: true } },
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    // Update request status to DOWNLOADING
    await prisma.request.update({
      where: { id: requestId },
      data: { status: "DOWNLOADING" },
    });

    return NextResponse.json(download);
  } catch (error) {
    console.error("Failed to add torrent:", error);

    // Still create download record with FAILED status
    const download = await prisma.download.create({
      data: {
        requestId,
        magnetUrl,
        status: "FAILED",
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });

    return NextResponse.json(
      { error: "Failed to add torrent", download },
      { status: 500 }
    );
  }
}
