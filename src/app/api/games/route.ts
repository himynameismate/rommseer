import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { igdbId, name, summary, coverUrl, releaseDate, rating, platformSlug, platformName } =
    body;

  if (!name || !platformSlug) {
    return NextResponse.json(
      { error: "name and platformSlug are required" },
      { status: 400 }
    );
  }

  // Find or create platform
  let platform = await prisma.platform.findUnique({
    where: { slug: platformSlug },
  });

  if (!platform) {
    platform = await prisma.platform.create({
      data: { slug: platformSlug, name: platformName || platformSlug },
    });
  }

  // Check if this exact game+platform combination already exists.
  // Uses the @@unique([igdbId, platformId]) composite constraint so
  // Advance Wars GBA and Advance Wars Switch are separate rows.
  if (igdbId) {
    const existing = await prisma.game.findUnique({
      where: { igdbId_platformId: { igdbId, platformId: platform.id } },
    });
    if (existing) {
      return NextResponse.json(existing);
    }
  }

  const game = await prisma.game.create({
    data: {
      igdbId,
      name,
      summary,
      coverUrl,
      releaseDate,
      rating,
      platformId: platform.id,
    },
  });

  return NextResponse.json(game, { status: 201 });
}
