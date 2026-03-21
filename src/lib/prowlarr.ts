import { prisma } from "@/lib/db";

export interface ProwlarrRelease {
  guid: string;
  title: string;
  size: number;
  seeders: number | null;
  leechers: number | null;
  downloadUrl: string | null;
  magnetUrl: string | null;
  infoUrl: string | null;
  infoHash: string | null;
  indexerId: number;
  indexer: string;
  publishDate: string;
  protocol: string;
  categories: { id: number; name: string }[];
  age: number;
  grabs: number | null;
  files: number | null;
}

export interface ProwlarrIndexer {
  id: number;
  name: string;
  enable: boolean;
  protocol: string;
  privacy: string;
  categories: { id: number; name: string; subCategories?: { id: number; name: string }[] }[];
}

export interface SearchOptions {
  query: string;
  categories?: number[];
  indexerIds?: number[];
  limit?: number;
}

export interface AutoGrabConfig {
  enabled: boolean;
  searchTemplate: string;
  minSeeders: number;
  maxSizeMb: number;
  preferredIndexers: string;
}

// Prowlarr category IDs for games/ROMs
export const GAME_CATEGORIES = [
  1000, // Console (general)
  1010, // Console/NDS
  1020, // Console/PSP
  1030, // Console/Wii
  1040, // Console/XBox
  1050, // Console/XBox 360
  1060, // Console/WiiWare/VC
  1070, // Console/XBox 360 DLC
  1080, // Console/PS3
  1090, // Console/Other
  1110, // Console/3DS
  1120, // Console/PS Vita
  1130, // Console/WiiU
  1140, // Console/XBox One
  1180, // Console/PS4
  4000, // PC (general)
  4050, // PC/Games
];

export class ProwlarrClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private async fetch<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${endpoint}`;
    const headers: Record<string, string> = {
      "X-Api-Key": this.apiKey,
      "Content-Type": "application/json",
      ...((options?.headers as Record<string, string>) || {}),
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      throw new Error(
        `Prowlarr API error: ${response.status} ${response.statusText}`
      );
    }

    return response.json();
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.fetch<{ version: string }>("/system/status");
      return true;
    } catch (error) {
      console.error("Prowlarr connection test failed:", error);
      return false;
    }
  }

  async getIndexers(): Promise<ProwlarrIndexer[]> {
    return this.fetch<ProwlarrIndexer[]>("/indexer");
  }

  async search(options: SearchOptions): Promise<ProwlarrRelease[]> {
    const params = new URLSearchParams();
    params.set("query", options.query);
    params.set("type", "search");

    if (options.categories && options.categories.length > 0) {
      options.categories.forEach((cat) => params.append("categories", String(cat)));
    }

    if (options.indexerIds && options.indexerIds.length > 0) {
      options.indexerIds.forEach((id) => params.append("indexerIds", String(id)));
    }

    if (options.limit) {
      params.set("limit", String(options.limit));
    }

    return this.fetch<ProwlarrRelease[]>(`/search?${params.toString()}`);
  }

  /**
   * Search for a game ROM and return results sorted by best match.
   * Sorts by: seeders (desc), then size (asc for ROMs — smaller is often better).
   */
  async searchForRom(
    gameName: string,
    platformName?: string,
    searchTemplate?: string,
    minSeeders = 0,
    maxSizeMb = 0
  ): Promise<ProwlarrRelease[]> {
    // Build search query from template
    let query: string;
    if (searchTemplate) {
      query = searchTemplate
        .replace("{game_name}", gameName)
        .replace("{platform}", platformName || "")
        .trim();
    } else {
      query = platformName ? `${gameName} ${platformName}` : gameName;
    }

    const results = await this.search({
      query,
      categories: GAME_CATEGORIES,
      limit: 50,
    });

    // Filter results
    let filtered = results.filter((r) => {
      // Must have a download URL or magnet URL
      if (!r.downloadUrl && !r.magnetUrl) return false;

      // Must be a torrent (not usenet)
      if (r.protocol !== "torrent") return false;

      // Minimum seeders filter
      if (minSeeders > 0 && (r.seeders ?? 0) < minSeeders) return false;

      // Max size filter (in MB)
      if (maxSizeMb > 0 && r.size > maxSizeMb * 1024 * 1024) return false;

      return true;
    });

    // Sort: most seeders first, then smallest size
    filtered.sort((a, b) => {
      const seedDiff = (b.seeders ?? 0) - (a.seeders ?? 0);
      if (seedDiff !== 0) return seedDiff;
      return a.size - b.size;
    });

    return filtered;
  }

  /**
   * Auto-grab: search for a ROM and return the best result.
   * Returns null if no suitable result found.
   */
  async autoGrab(
    gameName: string,
    platformName?: string,
    config?: Partial<AutoGrabConfig>
  ): Promise<ProwlarrRelease | null> {
    const results = await this.searchForRom(
      gameName,
      platformName,
      config?.searchTemplate,
      config?.minSeeders ?? 1,
      config?.maxSizeMb ?? 0
    );

    if (results.length === 0) return null;

    // If preferred indexers are set, try to find a result from them first
    if (config?.preferredIndexers) {
      const preferred = config.preferredIndexers
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      if (preferred.length > 0) {
        const preferredResult = results.find((r) =>
          preferred.includes(r.indexer.toLowerCase())
        );
        if (preferredResult) return preferredResult;
      }
    }

    // Return the best result (most seeders)
    return results[0];
  }
}

export async function getProwlarrClient(): Promise<ProwlarrClient | null> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.prowlarrUrl || !settings?.prowlarrApiKey) return null;
  return new ProwlarrClient(settings.prowlarrUrl, settings.prowlarrApiKey);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
