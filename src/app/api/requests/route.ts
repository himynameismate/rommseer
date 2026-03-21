import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

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

  const request = await prisma.request.create({
    data: {
      userId: session.user.id,
      gameId: Number(gameId),
      comment,
    },
    include: {
      game: { include: { platform: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  });

  return NextResponse.json(request, { status: 201 });
}
