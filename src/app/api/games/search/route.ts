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

    // Fetch all DB game rows matching these IGDB IDs — include platform slug so we
    // can build a (igdbId, platformSlug) → game map. Since the same igdbId can now
    // appear multiple times (once per platform), we must NOT collapse to a single
    // row per igdbId. Availability and request count are per (game, platform) pair.
    const igdbIds = results.map((r) => r.igdbId);
    const existingGames = await prisma.game.findMany({
      where: { igdbId: { in: igdbIds } },
      include: {
        requests: { select: { id: true, status: true } },
        platform: { select: { slug: true } },
      },
    });

    // Map: "igdbId-platformSlug" → game row
    const existingMap = new Map<string, typeof existingGames[0]>();
    for (const g of existingGames) {
      if (g.igdbId !== null) {
        existingMap.set(`${g.igdbId}-${g.platform.slug}`, g);
      }
    }

    const enrichedResults = results.map((result) => {
      // Enrich each platform with its own availability + request count
      const enrichedPlatforms = result.platforms.map((p) => {
        const existing = existingMap.get(`${result.igdbId}-${p.slug}`);
        return {
          ...p,
          isAvailable: existing?.isAvailable ?? false,
          requestCount: existing?.requests.length ?? 0,
        };
      });

      return {
        ...result,
        platforms: enrichedPlatforms,
        // Top-level isAvailable = any platform version is in library (for the card badge)
        isAvailable: enrichedPlatforms.some((p) => p.isAvailable),
        // Top-level requestCount = total across all platforms
        requestCount: enrichedPlatforms.reduce((sum, p) => sum + p.requestCount, 0),
      };
    });

    return NextResponse.json(enrichedResults);
  } catch (error) {
    console.error("Game search failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
