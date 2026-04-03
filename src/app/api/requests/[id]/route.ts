import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { autoGrabForRequest } from "@/lib/autograb";
import { notify, logActivity } from "@/lib/notifications";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { status, adminNote } = body;
  const isAdmin = session.user.role === "ADMIN";

  // Users can cancel their own PENDING requests
  if (!isAdmin) {
    if (status !== "CANCELLED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const ownRequest = await prisma.request.findUnique({
      where: { id: Number(params.id) },
      include: { game: { include: { platform: true } }, user: { select: { id: true, name: true, email: true } } },
    });
    if (!ownRequest || ownRequest.userId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (ownRequest.status !== "PENDING") {
      return NextResponse.json({ error: "Only pending requests can be cancelled" }, { status: 400 });
    }
    const cancelled = await prisma.request.update({
      where: { id: Number(params.id) },
      data: { status: "CANCELLED" },
      include: {
        game: { include: { platform: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    });

    // Log activity + notify
    logActivity("CANCELLED", `${session.user.name} cancelled request for "${ownRequest.game.name}"`, {
      userId: session.user.id, requestId: ownRequest.id,
    });
    notify({
      event: "CANCELLED", gameName: ownRequest.game.name, platformName: ownRequest.game.platform.name,
      userName: session.user.name || "Unknown", coverUrl: ownRequest.game.coverUrl,
    });

    return NextResponse.json(cancelled);
  }

  if (!["APPROVED", "DECLINED", "AVAILABLE", "DOWNLOADING", "RETRY", "CANCELLED"].includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // Check current status to prevent duplicate auto-grabs
  const currentRequest = await prisma.request.findUnique({
    where: { id: Number(params.id) },
    include: { game: { include: { platform: true } }, user: { select: { id: true, name: true, email: true } } },
  });

  if (!currentRequest) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  // Handle RETRY — clean up failed downloads and re-run auto-grab
  if (status === "RETRY") {
    await prisma.download.deleteMany({
      where: { requestId: Number(params.id), status: "FAILED" },
    });

    const request = await prisma.request.update({
      where: { id: Number(params.id) },
      data: { status: "APPROVED" },
      include: {
        game: { include: { platform: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    });

    logActivity("RETRY", `Admin retried auto-grab for "${request.game.name}"`, {
      userId: session.user.id, requestId: request.id,
    });

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (settings?.prowlarrAutoGrab && settings?.prowlarrUrl) {
      autoGrabForRequest(request.id)
        .then((result) => {
          console.log(`[AutoGrab] Retry completed for request ${request.id}:`, result.message);
        })
        .catch((err) => {
          console.error(`[AutoGrab] Retry error for request ${request.id}:`, err);
        });

      return NextResponse.json({
        ...request,
        autoGrab: {
          success: true,
          message: "Retry auto-grab started in background...",
        },
      });
    }

    return NextResponse.json(request);
  }

  // Don't re-approve if already available
  if (status === "APPROVED" && currentRequest.status === "AVAILABLE") {
    return NextResponse.json({ error: "Request is already available" }, { status: 400 });
  }

  // Build update data with optional adminNote
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = { status };
  if (adminNote !== undefined) updateData.adminNote = adminNote;

  const request = await prisma.request.update({
    where: { id: Number(params.id) },
    data: updateData,
    include: {
      game: { include: { platform: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  });

  // Log activity + send notification based on status change
  const gameName = request.game.name;
  const platformName = request.game.platform.name;
  const userName = request.user.name;
  const coverUrl = request.game.coverUrl;

  if (status === "APPROVED") {
    logActivity("APPROVED", `"${gameName}" approved by ${session.user.name}`, {
      userId: session.user.id, requestId: request.id,
    });
    notify({ event: "APPROVED", gameName, platformName, userName, coverUrl, userId: request.userId, requestId: request.id });
  } else if (status === "DECLINED") {
    logActivity("DECLINED", `"${gameName}" declined by ${session.user.name}${adminNote ? `: ${adminNote}` : ""}`, {
      userId: session.user.id, requestId: request.id, metadata: adminNote ? { reason: adminNote } : undefined,
    });
    notify({ event: "DECLINED", gameName, platformName, userName, coverUrl, adminNote, userId: request.userId, requestId: request.id });
  } else if (status === "AVAILABLE") {
    logActivity("AVAILABLE", `"${gameName}" marked available by ${session.user.name}`, {
      userId: session.user.id, requestId: request.id,
    });
    notify({ event: "AVAILABLE", gameName, platformName, userName, coverUrl, userId: request.userId, requestId: request.id });
  }

  // If approved from PENDING, try auto-grab via Prowlarr (non-blocking)
  if (status === "APPROVED" && currentRequest.status === "PENDING") {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (settings?.prowlarrAutoGrab && settings?.prowlarrUrl) {
      autoGrabForRequest(request.id)
        .then((result) => {
          console.log(`[AutoGrab] Completed for request ${request.id}:`, result.message);
        })
        .catch((err) => {
          console.error(`[AutoGrab] Error for request ${request.id}:`, err);
        });

      return NextResponse.json({
        ...request,
        autoGrab: {
          success: true,
          message: "Auto-grab started in background...",
        },
      });
    }
  }

  return NextResponse.json(request);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const request = await prisma.request.findUnique({
    where: { id: Number(params.id) },
  });

  if (!request) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (session.user.role !== "ADMIN" && request.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Delete associated activities, downloads, then the request
  await prisma.activity.deleteMany({ where: { requestId: Number(params.id) } });
  await prisma.download.deleteMany({ where: { requestId: Number(params.id) } });
  await prisma.request.delete({ where: { id: Number(params.id) } });

  return NextResponse.json({ success: true });
}
