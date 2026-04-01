import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const invites = await prisma.invite.findMany({
    include: {
      createdBy: {
        select: { name: true, email: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(invites);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { email, expiresInHours } = body;

  if (email && (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
  }

  const hours = typeof expiresInHours === "number" && expiresInHours > 0
    ? Math.min(expiresInHours, 720)
    : 48;

  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  const invite = await prisma.invite.create({
    data: {
      email: email ? String(email).toLowerCase() : null,
      createdById: session.user.id,
      expiresAt,
    },
  });

  return NextResponse.json(invite, { status: 201 });
}
