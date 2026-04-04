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
  const search = searchParams.get("search") || "";
  const platformSlug = searchParams.get("platform") || "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "48", 10)));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { isAvailable: true };

  if (search) {
    where.name = { contains: search };
  }

  if (platformSlug) {
    where.platform = { slug: platformSlug };
  }

  const [games, total, platforms] = await Promise.all([
    prisma.game.findMany({
      where,
      include: {
        platform: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.game.count({ where }),
    // Get all platforms that have available games (for the filter)
    prisma.platform.findMany({
      where: {
        games: { some: { isAvailable: true } },
      },
      select: { id: true, name: true, slug: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return NextResponse.json({
    games,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    platforms,
  });
}
