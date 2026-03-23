import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { autoGrabForRequest } from "@/lib/autograb";
import { syncAndRetryDownloads } from "@/lib/sync";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const page = Math.max(1, Number(searchParams.get("page") || "1"));
  const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || "50")));
  const isAdmin = session.user.role === "ADMIN";

  // Validate status parameter against allowed values
  const ALLOWED_STATUSES = ["PENDING", "APPROVED", "DECLINED", "AVAILABLE", "DOWNLOADING"];
  if (status && !ALLOWED_STATUSES.includes(status)) {
    return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
  }

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (!isAdmin) where.userId = session.user.id;

  // Fire-and-forget sync for admin (non-blocking, Issue #14)
  if (isAdmin) {
    syncDownloadingRequests().catch((e) => console.error("[Sync] Background sync error:", e));
  }

  const requests = await prisma.request.findMany({
    where,
    include: {
      game: { include: { platform: true } },
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * limit,
    take: limit,
  });

  return NextResponse.json(requests);
}

/** Sync download status from SABnzbd/qBit and auto-retry failed ones. */
async function syncDownloadingRequests() {
  const downloadingRequests = await prisma.request.findMany({
    where: { status: "DOWNLOADING" },
    select: { id: true },
  });
  if (!downloadingRequests.length) return;

  const downloads = await prisma.download.findMany({
    where: { requestId: { in: downloadingRequests.map((r) => r.id) }, status: "DOWNLOADING" },
  });
  if (!downloads.length) return;

  await syncAndRetryDownloads(downloads);
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

  // Validate comment length
  if (comment !== undefined && comment !== null && typeof comment === "string" && comment.length > 1000) {
    return NextResponse.json(
      { error: "Comment must be 1000 characters or less" },
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
