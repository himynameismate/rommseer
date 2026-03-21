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

  if (!["APPROVED", "DECLINED", "AVAILABLE", "DOWNLOADING"].includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const request = await prisma.request.update({
    where: { id: Number(params.id) },
    data: { status },
    include: {
      game: { include: { platform: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  });

  // If approved, try auto-grab via Prowlarr + qBittorrent
  let autoGrabResult = null;
  if (status === "APPROVED") {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (settings?.prowlarrAutoGrab && settings?.prowlarrUrl && settings?.qbitUrl) {
      autoGrabResult = await autoGrabForRequest(request.id);
      // Re-fetch the request to get updated status
      const updatedRequest = await prisma.request.findUnique({
        where: { id: request.id },
        include: {
          game: { include: { platform: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      });
      return NextResponse.json({
        ...updatedRequest,
        autoGrab: autoGrabResult,
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

  // Only admin or the request owner can delete
  if (session.user.role !== "ADMIN" && request.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.request.delete({ where: { id: Number(params.id) } });

  return NextResponse.json({ success: true });
}
