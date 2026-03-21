import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [
    totalRequests,
    pendingRequests,
    approvedRequests,
    availableGames,
    totalUsers,
    recentRequests,
  ] = await Promise.all([
    prisma.request.count(),
    prisma.request.count({ where: { status: "PENDING" } }),
    prisma.request.count({ where: { status: "APPROVED" } }),
    prisma.game.count({ where: { isAvailable: true } }),
    prisma.user.count(),
    prisma.request.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      include: {
        game: { include: { platform: true } },
        user: { select: { id: true, name: true } },
      },
    }),
  ]);

  return NextResponse.json({
    totalRequests,
    pendingRequests,
    approvedRequests,
    availableGames,
    totalUsers,
    recentRequests,
  });
}
