import { prisma } from "@/lib/db";

interface IGDBGame {
  id: number;
  name: string;
  summary?: string;
  cover?: { image_id: string };
  first_release_date?: number;
  total_rating?: number;
  platforms?: { id: number; name: string; slug: string }[];
}

export interface GameSearchResult {
  igdbId: number;
  name: string;
  summary: string | null;
  coverUrl: string | null;
  releaseDate: string | null;
  rating: number | null;
  platforms: { id: number; name: string; slug: string }[];
}

let accessToken: string | null = null;
let tokenExpiry: number = 0;

async function getAccessToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken;
  }

  const response = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
    { method: "POST" }
  );

  if (!response.ok) {
    throw new Error("Failed to authenticate with IGDB/Twitch");
  }

  const data = await response.json();
  accessToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000 - 60000;
  return accessToken!;
}

export async function searchGames(
  query: string,
  limit = 20
): Promise<GameSearchResult[]> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.igdbClientId || !settings?.igdbClientSecret) {
    throw new Error("IGDB credentials not configured");
  }

  const token = await getAccessToken(
    settings.igdbClientId,
    settings.igdbClientSecret
  );

  const response = await fetch("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: {
      "Client-ID": settings.igdbClientId,
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body: `search "${query}"; fields name, summary, cover.image_id, first_release_date, total_rating, platforms.name, platforms.slug; limit ${limit};`,
  });

  if (!response.ok) {
    throw new Error(`IGDB API error: ${response.status}`);
  }

  const games: IGDBGame[] = await response.json();

  return games.map((game) => ({
    igdbId: game.id,
    name: game.name,
    summary: game.summary ?? null,
    coverUrl: game.cover
      ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
      : null,
    releaseDate: game.first_release_date
      ? new Date(game.first_release_date * 1000).toISOString().split("T")[0]
      : null,
    rating: game.total_rating ? Math.round(game.total_rating) : null,
    platforms: game.platforms ?? [],
  }));
}

export async function getGameById(
  igdbId: number
): Promise<GameSearchResult | null> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.igdbClientId || !settings?.igdbClientSecret) return null;

  const token = await getAccessToken(
    settings.igdbClientId,
    settings.igdbClientSecret
  );

  const response = await fetch("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: {
      "Client-ID": settings.igdbClientId,
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body: `where id = ${igdbId}; fields name, summary, cover.image_id, first_release_date, total_rating, platforms.name, platforms.slug; limit 1;`,
  });

  if (!response.ok) return null;

  const games: IGDBGame[] = await response.json();
  if (games.length === 0) return null;

  const game = games[0];
  return {
    igdbId: game.id,
    name: game.name,
    summary: game.summary ?? null,
    coverUrl: game.cover
      ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
      : null,
    releaseDate: game.first_release_date
      ? new Date(game.first_release_date * 1000).toISOString().split("T")[0]
      : null,
    rating: game.total_rating ? Math.round(game.total_rating) : null,
    platforms: game.platforms ?? [],
  };
}
