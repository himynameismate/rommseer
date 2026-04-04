import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCachedRomMClient } from "@/lib/clients";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const search = (searchParams.get("search") || "").toLowerCase();
  const platformSlug = searchParams.get("platform") || "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "48", 10)));

  const romm = await getCachedRomMClient();
  if (!romm) {
    return NextResponse.json({
      games: [],
      total: 0,
      page: 1,
      pageSize,
      totalPages: 0,
      platforms: [],
      error: "RomM not configured",
    });
  }

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const rommBaseUrl = (settings?.rommUrl || "").replace(/\/$/, "");

  try {
    // Fetch platforms for name/slug lookup (ROM objects may have incomplete platform info)
    const platforms = await romm.getPlatforms();
    const platformById = new Map(platforms.map((p) => [p.id, p]));

    // Fetch ALL ROMs in a single call — avoids duplicates from per-platform calls
    const allRoms = await romm.getRoms();

    // Enrich each ROM with platform info from the platforms lookup
    interface EnrichedRom {
      id: number;
      name: string;
      summary: string;
      file_name: string;
      file_size_bytes: number;
      url_cover: string;
      path_cover_s: string;
      path_cover_l: string;
      platformId: number;
      platformName: string;
      platformSlug: string;
    }

    const enriched: EnrichedRom[] = [];
    for (const rom of allRoms) {
      const plat = platformById.get(rom.platform_id);
      enriched.push({
        id: rom.id,
        name: rom.name,
        summary: rom.summary,
        file_name: rom.file_name,
        file_size_bytes: rom.file_size_bytes,
        url_cover: rom.url_cover,
        path_cover_s: rom.path_cover_s,
        path_cover_l: rom.path_cover_l,
        platformId: rom.platform_id,
        platformName: plat?.name || rom.platform_name || "Unknown",
        platformSlug: plat?.slug || rom.platform_slug || "unknown",
      });
    }

    // Build platform list for filter bar (from all ROMs, before search/platform filter)
    const platformMap = new Map<string, { id: number; name: string; slug: string }>();
    for (const rom of enriched) {
      if (!platformMap.has(rom.platformSlug)) {
        platformMap.set(rom.platformSlug, {
          id: rom.platformId,
          name: rom.platformName,
          slug: rom.platformSlug,
        });
      }
    }
    const platformList = Array.from(platformMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    // Apply platform filter
    let filtered = enriched;
    if (platformSlug) {
      filtered = filtered.filter((rom) => rom.platformSlug === platformSlug);
    }

    // Apply search filter
    if (search) {
      filtered = filtered.filter((rom) =>
        rom.name.toLowerCase().includes(search)
      );
    }

    // Sort alphabetically
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    // Paginate
    const total = filtered.length;
    const totalPages = Math.ceil(total / pageSize);
    const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

    // Map to response format
    const games = paged.map((rom) => {
      let coverUrl: string | null = null;
      if (rom.url_cover) {
        coverUrl = rom.url_cover;
      } else if (rom.path_cover_l && rommBaseUrl) {
        coverUrl = `${rommBaseUrl}/assets/romm/resources/${rom.path_cover_l}`;
      } else if (rom.path_cover_s && rommBaseUrl) {
        coverUrl = `${rommBaseUrl}/assets/romm/resources/${rom.path_cover_s}`;
      }

      return {
        id: rom.id,
        name: rom.name,
        coverUrl,
        summary: rom.summary || null,
        fileName: rom.file_name,
        fileSize: rom.file_size_bytes,
        platform: {
          id: rom.platformId,
          name: rom.platformName,
          slug: rom.platformSlug,
        },
      };
    });

    return NextResponse.json({
      games,
      total,
      page,
      pageSize,
      totalPages,
      platforms: platformList,
    });
  } catch (error) {
    console.error("Library fetch error:", error);
    return NextResponse.json({
      games: [],
      total: 0,
      page: 1,
      pageSize,
      totalPages: 0,
      platforms: [],
      error: "Failed to fetch from RomM",
    });
  }
}
