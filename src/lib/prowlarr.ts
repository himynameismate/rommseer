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

const GAME_CATEGORIES = [
  1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090,
  1110, 1120, 1130, 1140, 1180, 4000, 4050,
];

const stripAccents = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const validUrl = (u: string | null, ...schemes: string[]) => u ? schemes.some((s) => u.startsWith(s)) : false;

// File extensions that are NEVER ROMs — reject results containing these in the title
const BLOCKED_EXTENSIONS = [
  ".epub", ".pdf", ".mobi", ".azw", ".djvu", ".cbr", ".cbz", // books/comics
  ".mp3", ".flac", ".ogg", ".aac", ".wav", ".m4a", // audio
  ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", // video
  ".exe", ".msi", ".dmg", ".pkg", ".deb", ".rpm", ".apk", // installers
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", // documents
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".tiff", // images
];

// Valid ROM/game extensions per platform (lowercase). If a platform isn't listed, no extension filter is applied.
const PLATFORM_EXTENSIONS: Record<string, string[]> = {
  // Nintendo - Handhelds
  "game boy": [".gb"],
  "game boy color": [".gbc", ".gb"],
  "game boy advance": [".gba"],
  "nintendo ds": [".nds", ".dsi", ".srl"],
  "nintendo dsi": [".nds", ".dsi", ".srl"],
  "nintendo 3ds": [".3ds", ".cia", ".cxi", ".cci"],
  "new nintendo 3ds": [".3ds", ".cia", ".cxi", ".cci"],
  // Nintendo - Home Consoles
  "nintendo entertainment system": [".nes", ".unf", ".unif", ".fds"],
  "nes": [".nes", ".unf", ".unif", ".fds"],
  "famicom": [".nes", ".unf", ".unif", ".fds"],
  "family computer": [".nes", ".unf", ".unif", ".fds"],
  "famicom disk system": [".fds", ".nes"],
  "super nintendo entertainment system": [".sfc", ".smc", ".fig", ".swc"],
  "super nintendo": [".sfc", ".smc", ".fig", ".swc"],
  "snes": [".sfc", ".smc", ".fig", ".swc"],
  "super famicom": [".sfc", ".smc", ".fig", ".swc"],
  "nintendo 64": [".n64", ".z64", ".v64", ".ndd"],
  "nintendo 64dd": [".n64", ".z64", ".v64", ".ndd"],
  "gamecube": [".iso", ".gcm", ".gcz", ".rvz", ".nkit", ".ciso"],
  "nintendo gamecube": [".iso", ".gcm", ".gcz", ".rvz", ".nkit", ".ciso"],
  "wii": [".iso", ".wbfs", ".rvz", ".nkit", ".wad", ".ciso"],
  "wii u": [".wud", ".wux", ".rpx", ".wua", ".iso"],
  "nintendo switch": [".nsp", ".xci", ".nsz", ".xcz"],
  // Nintendo - Other
  "virtual boy": [".vb", ".vboy"],
  "pokémon mini": [".min"],
  "game & watch": [".mgw"],
  // Sony
  "playstation": [".bin", ".cue", ".iso", ".img", ".pbp", ".chd"],
  "playstation 2": [".iso", ".bin", ".chd"],
  "playstation 3": [".iso", ".pkg"],
  "playstation portable": [".iso", ".cso", ".pbp"],
  "playstation vita": [".vpk", ".mai"],
  // Sega
  "sega master system": [".sms"],
  "sega mega drive/genesis": [".md", ".gen", ".bin", ".smd"],
  "genesis": [".md", ".gen", ".bin", ".smd"],
  "mega drive": [".md", ".gen", ".bin", ".smd"],
  "sega saturn": [".iso", ".bin", ".cue", ".chd"],
  "dreamcast": [".gdi", ".cdi", ".chd"],
  "game gear": [".gg"],
  // Other
  "xbox": [".iso", ".xiso"],
  "xbox 360": [".iso", ".xex"],
  "neo geo": [".neo"],
  "turbografx-16": [".pce"],
  "atari 2600": [".a26", ".bin"],
  "arcade": [".zip", ".7z"],
  "mame": [".zip", ".7z"],
  // PC
  "pc (microsoft windows)": [".iso", ".zip", ".7z", ".rar", ".exe"],
};

/** Check if a result title contains a blocked (non-ROM) file extension */
function hasBlockedExtension(title: string): boolean {
  const lower = title.toLowerCase();
  return BLOCKED_EXTENSIONS.some((ext) => lower.includes(ext));
}

// All valid ROM extensions across ALL platforms — used to detect if a title mentions any ROM format
const ALL_ROM_EXTENSIONS = [...new Set(Object.values(PLATFORM_EXTENSIONS).flat())];

/** Check if a result title is compatible with the target platform's ROM extensions */
function matchesPlatformExtensions(title: string, platformName?: string): boolean {
  if (!platformName) return true;
  const exts = PLATFORM_EXTENSIONS[platformName.toLowerCase()];
  if (!exts) return true; // Unknown platform, no filtering

  const lower = title.toLowerCase();

  // If title contains a valid extension for THIS platform, it's a match
  if (exts.some((ext) => lower.includes(ext))) return true;

  // If title contains generic archive extensions, allow (ROM packs use these)
  if ([".zip", ".7z", ".rar"].some((ext) => lower.includes(ext))) return true;

  // If title contains a ROM extension for a DIFFERENT platform, block it
  const hasOtherRomExt = ALL_ROM_EXTENSIONS.some((ext) => lower.includes(ext) && !exts.includes(ext));
  if (hasOtherRomExt) return false;

  // No ROM extension detected at all — allow it (most titles don't include extensions)
  return true;
}

/** Check if a result title is relevant to the game we're searching for */
function isTitleRelevant(title: string, gameName: string): boolean {
  const normalize = (s: string) => stripAccents(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim());
  const t = normalize(title);
  const clean = gameName.split(":")[0].trim();
  const simple = clean.replace(/\s*(Version|Edition|Special)\s*/gi, " ").replace(/\s+/g, " ").trim();

  // Build normalized name variants
  const names = [...new Set([gameName, clean, simple].map(normalize))].filter(Boolean);

  // Title must contain the game name as a contiguous phrase (not scattered words)
  // e.g., "Advance Wars" must appear as "advance wars" in the title, not "advance...wars" separately
  return names.some((name) => t.includes(name));
}

export class ProwlarrClient {
  constructor(private baseUrl: string, private apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${endpoint}`, {
      ...options,
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json", ...((options?.headers as Record<string, string>) || {}) },
    });
    if (!res.ok) throw new Error(`Prowlarr API error: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async testConnection(): Promise<boolean> {
    try { await this.fetch("/system/status"); return true; }
    catch { return false; }
  }

  async getIndexers(): Promise<ProwlarrIndexer[]> {
    return this.fetch("/indexer");
  }

  async search(query: string, categories?: number[], limit = 50): Promise<ProwlarrRelease[]> {
    const p = new URLSearchParams({ query, type: "search", limit: String(limit) });
    categories?.forEach((c) => p.append("categories", String(c)));
    return this.fetch(`/search?${p}`);
  }

  /** Search with progressive query simplification, returns filtered+sorted results. */
  async searchForRom(gameName: string, platformName?: string, searchTemplate?: string, minSeeders = 0, maxSizeMb = 0): Promise<ProwlarrRelease[]> {
    const queries = this.buildQueries(gameName, platformName, searchTemplate);
    const seen = new Set<string>();
    const all: ProwlarrRelease[] = [];

    for (const q of queries) {
      const [cat, noCat] = await Promise.all([
        this.search(q, GAME_CATEGORIES),
        this.search(q),
      ]);
      let added = 0;
      for (const r of [...cat, ...noCat]) {
        const key = r.guid || `${r.title}-${r.indexer}-${r.size}`;
        if (!seen.has(key)) { seen.add(key); all.push(r); added++; }
      }
      console.log(`[Prowlarr] "${q}": ${cat.length}+${noCat.length} raw, ${added} new (${all.length} total)`);
    }

    const maxSize = maxSizeMb > 0 ? maxSizeMb * 1024 * 1024 : Infinity;
    const filtered = all.filter((r) => {
      if (!validUrl(r.downloadUrl, "http://", "https://") && !validUrl(r.magnetUrl, "magnet:", "http")) return false;
      if (r.protocol !== "usenet" && minSeeders > 0 && (r.seeders ?? 0) < minSeeders) return false;
      if (r.size > maxSize) return false;
      // Title must actually contain the game name
      if (!isTitleRelevant(r.title, gameName)) {
        console.log(`[Prowlarr] BLOCKED "${r.title}": not relevant to "${gameName}"`);
        return false;
      }
      // Block results with non-ROM file extensions (ebooks, videos, etc.)
      if (hasBlockedExtension(r.title)) {
        console.log(`[Prowlarr] BLOCKED "${r.title}": non-ROM file extension`);
        return false;
      }
      // Check platform-specific extensions
      if (!matchesPlatformExtensions(r.title, platformName)) {
        console.log(`[Prowlarr] BLOCKED "${r.title}": wrong extension for ${platformName}`);
        return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const score = (r: ProwlarrRelease) => r.protocol === "usenet" ? (r.grabs ?? 0) : (r.seeders ?? 0);
      return score(b) - score(a) || a.size - b.size;
    });

    console.log(`[Prowlarr] ${all.length} total → ${filtered.length} after filter/sort`);
    return filtered;
  }

  private buildQueries(name: string, platform?: string, template?: string): string[] {
    const q: string[] = [];
    const clean = name.split(":")[0].trim();
    const simple = clean.replace(/\s*(Version|Edition|Special)\s*/gi, " ").replace(/\s+/g, " ").trim();
    const ascii = stripAccents(simple || clean);

    if (template) q.push(template.replace("{game_name}", name).replace("{platform}", platform || "").trim());
    if (platform) q.push(`${name} ${platform}`);
    q.push(name);
    if (clean !== name) { if (platform) q.push(`${clean} ${platform}`); q.push(clean); }
    if (simple !== clean) { if (platform) q.push(`${simple} ${platform}`); q.push(simple); }
    if (ascii !== (simple || clean)) { if (platform) q.push(`${ascii} ${platform}`); q.push(ascii); }

    return [...new Set(q)];
  }

  /** Download a .torrent/.nzb file through Prowlarr (handles indexer auth). */
  async downloadFile(downloadUrl: string): Promise<Buffer | null> {
    try {
      const res = await fetch(downloadUrl, { headers: { "X-Api-Key": this.apiKey }, redirect: "follow" });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      console.error("[Prowlarr] Download error:", e instanceof Error ? e.message : e);
      return null;
    }
  }
}

export async function getProwlarrClient(): Promise<ProwlarrClient | null> {
  const s = await prisma.settings.findUnique({ where: { id: 1 } });
  return s?.prowlarrUrl && s?.prowlarrApiKey ? new ProwlarrClient(s.prowlarrUrl, s.prowlarrApiKey) : null;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024, sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
