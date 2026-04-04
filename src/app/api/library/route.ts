import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCachedRomMClient } from "@/lib/clients";
import { prisma } from "@/lib/db";

interface RomMRom {
  id: number;
  igdb_id: number | null;
  name: string;
  slug: string;
  summary: string;
  platform_id: number;
  platform_slug: string;
  platform_name: string;
  file_name: string;
  file_size_bytes: number;
  path_cover_s: string;
  path_cover_l: string;
  url_cover: string;
}

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

  // Get the RomM base URL for building cover image URLs
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const rommBaseUrl = (settings?.rommUrl || "").replace(/\/$/, "");

  try {
    const platforms = await romm.getPlatforms();

    // Filter to requested platform if specified
    const targetPlatforms = platformSlug
      ? platforms.filter((p) => p.slug === platformSlug)
      : platforms.filter((p) => p.rom_count > 0);

    // Fetch ROMs from all relevant platforms
    const allRoms: RomMRom[] = [];
    for (const platform of targetPlatforms) {
      if (platform.rom_count === 0) continue;
      try {
        const roms = await romm.getRoms(platform.id);
        // Attach platform info since getRoms may not include it
        for (const rom of roms) {
          if (!rom.platform_name) rom.platform_name = platform.name;
          if (!rom.platform_slug) rom.platform_slug = platform.slug;
          allRoms.push(rom);
        }
      } catch {
        // Skip platforms that fail to load
      }
    }

    // Apply search filter
    let filtered = allRoms;
    if (search) {
      filtered = allRoms.filter((rom) =>
        rom.name.toLowerCase().includes(search)
      );
    }

    // Sort alphabetically
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    // Build platform list from all ROMs (before search filter, for the filter bar)
    const platformMap = new Map<string, { id: number; name: string; slug: string }>();
    for (const rom of allRoms) {
      if (!platformMap.has(rom.platform_slug)) {
        platformMap.set(rom.platform_slug, {
          id: rom.platform_id,
          name: rom.platform_name,
          slug: rom.platform_slug,
        });
      }
    }
    const platformList = Array.from(platformMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    // Paginate
    const total = filtered.length;
    const totalPages = Math.ceil(total / pageSize);
    const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

    // Map to response format
    const games = paged.map((rom) => {
      // Build cover URL — RomM serves covers at /api/roms/{id}/cover
      // or we can use path_cover_l which is a relative path
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
          id: rom.platform_id,
          name: rom.platform_name,
          slug: rom.platform_slug,
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
