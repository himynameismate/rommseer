import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCachedProwlarrClient } from "@/lib/clients";

// GET /api/prowlarr?q=query&platform=platformName - Search Prowlarr for ROMs
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const query = req.nextUrl.searchParams.get("q");
  const platform = req.nextUrl.searchParams.get("platform") || undefined;

  if (!query) {
    return NextResponse.json(
      { error: "Search query is required" },
      { status: 400 }
    );
  }

  const client = await getCachedProwlarrClient();
  if (!client) {
    return NextResponse.json(
      { error: "Prowlarr not configured" },
      { status: 400 }
    );
  }

  try {
    const results = await client.searchForRom(query, platform);
    return NextResponse.json(results);
  } catch (error) {
    console.error("Prowlarr search failed:", error);
    return NextResponse.json(
      { error: "Prowlarr search failed" },
      { status: 500 }
    );
  }
}
