import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { searchGames } from "@/lib/igdb";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const query = searchParams.get("q");

  if (!query) {
    return NextResponse.json({ error: "Query required" }, { status: 400 });
  }

  try {
    const results = await searchGames(query);

    // Check which games are already in our DB (requested or available)
    const igdbIds = results.map((r) => r.igdbId);
    const existingGames = await prisma.game.findMany({
      where: { igdbId: { in: igdbIds } },
      include: { requests: { select: { id: true, status: true } } },
    });

    const existingMap = new Map(
      existingGames.map((g) => [g.igdbId, g])
    );

    const enrichedResults = results.map((result) => {
      const existing = existingMap.get(result.igdbId);
      return {
        ...result,
        dbId: existing?.id ?? null,
        isAvailable: existing?.isAvailable ?? false,
        requestCount: existing?.requests.length ?? 0,
      };
    });

    return NextResponse.json(enrichedResults);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
