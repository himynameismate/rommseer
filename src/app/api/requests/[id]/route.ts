import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { autoGrabForRequest } from "@/lib/autograb";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { status } = body;

  if (!["APPROVED", "DECLINED", "AVAILABLE", "DOWNLOADING", "RETRY"].includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // Check current status to prevent duplicate auto-grabs
  const currentRequest = await prisma.request.findUnique({
    where: { id: Number(params.id) },
  });

  if (!currentRequest) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  // Handle RETRY — clean up failed downloads and re-run auto-grab
  if (status === "RETRY") {
    // Delete failed download records so auto-grab can create fresh ones
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

  const request = await prisma.request.update({
    where: { id: Number(params.id) },
    data: { status },
    include: {
      game: { include: { platform: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  });

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

  // Delete associated downloads first, then the request
  await prisma.download.deleteMany({ where: { requestId: Number(params.id) } });
  await prisma.request.delete({ where: { id: Number(params.id) } });

  return NextResponse.json({ success: true });
}
