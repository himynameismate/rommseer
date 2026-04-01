import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { role?: string; isApproved?: boolean; requestQuota?: number; requestQuotaDays?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { role, isApproved, requestQuota, requestQuotaDays } = body;

  if (role !== undefined && role !== "ADMIN" && role !== "USER") {
    return NextResponse.json({ error: "Role must be ADMIN or USER" }, { status: 400 });
  }

  // Build update data
  const data: Record<string, unknown> = {};
  if (role !== undefined) data.role = role;
  if (requestQuota !== undefined) data.requestQuota = Number(requestQuota);
  if (requestQuotaDays !== undefined) data.requestQuotaDays = Number(requestQuotaDays);

  if (isApproved !== undefined) {
    data.isApproved = isApproved;
    if (isApproved) {
      // Only set approvedAt if the user wasn't already approved
      const existing = await prisma.user.findUnique({
        where: { id: params.id },
        select: { isApproved: true },
      });
      if (!existing) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }
      if (!existing.isApproved) {
        data.approvedAt = new Date();
      }
    }
  }

  const user = await prisma.user.update({
    where: { id: params.id },
    data,
  });

  return NextResponse.json(user);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (params.id === session.user.id) {
    return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await prisma.user.delete({ where: { id: params.id } });

  return NextResponse.json({ success: true });
}
