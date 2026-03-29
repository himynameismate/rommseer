import { prisma } from "@/lib/db";

/** Strip sensitive query parameters (apikey, api_key) from URLs before logging */
function sanitizeUrl(url: string): string {
  return url.replace(/([?&])(apikey|api_key)=[^&]*/gi, "$1$2=***");
}

export type DownloadFileResult =
  | { type: "file"; data: Buffer }
  | { type: "magnet"; url: string };

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
const ALL_ROM_EXTENSIONS = Array.from(new Set(Object.values(PLATFORM_EXTENSIONS).flat()));

/** Check if a result title is compatible with the target platform's ROM extensions */
function matchesPlatformExtensions(title: string, platformName?: string): boolean {
  if (!platformName) return true;
  const pLower = platformName.toLowerCase();
  // Try direct match first, then reverse-lookup via PLATFORM_KEYWORDS
  let exts = PLATFORM_EXTENSIONS[pLower];
  if (!exts) {
    // Reverse lookup: "gba" → find "game boy advance" in PLATFORM_KEYWORDS → use its extensions
    for (const [platform, keywords] of Object.entries(PLATFORM_KEYWORDS)) {
      if (keywords.some((kw) => kw.toLowerCase() === pLower) && PLATFORM_EXTENSIONS[platform]) {
        exts = PLATFORM_EXTENSIONS[platform];
        break;
      }
    }
  }
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

// Platform keywords/abbreviations that, if found in a result title, indicate a specific platform.
// Used to detect when a result is for a DIFFERENT platform than requested.
const PLATFORM_KEYWORDS: Record<string, string[]> = {
  "game boy advance": ["gba", "game boy advance"],
  "game boy color": ["gbc", "game boy color", "gameboy color"],
  "game boy": ["gb", "game boy", "gameboy"],
  "nintendo ds": ["nds", "nintendo ds"],
  "nintendo dsi": ["nds", "dsi", "nintendo ds"],
  "nintendo 3ds": ["3ds", "citra", "nintendo 3ds"],
  "new nintendo 3ds": ["3ds", "citra"],
  "nintendo entertainment system": ["nes"],
  "nes": ["nes"],
  "super nintendo entertainment system": ["snes", "sfc", "super nintendo"],
  "super nintendo": ["snes", "sfc", "super nintendo"],
  "snes": ["snes", "sfc"],
  "nintendo 64": ["n64", "nintendo 64"],
  "gamecube": ["gcn", "gamecube", "ngc", "nintendo gamecube"],
  "nintendo gamecube": ["gcn", "gamecube", "ngc", "nintendo gamecube"],
  "wii": ["wii", "virtual console", "wiiware", "nintendo wii"],
  "wii u": ["wii u", "wiiu", "nintendo wii u"],
  "nintendo switch": ["switch", "nsw", "nsp", "xci", "nintendo switch"],
  "playstation": ["psx", "ps1", "playstation"],
  "playstation 2": ["ps2", "playstation 2"],
  "playstation 3": ["ps3", "playstation 3"],
  "playstation portable": ["psp"],
  "playstation vita": ["vita", "psvita"],
  "sega mega drive/genesis": ["genesis", "mega drive", "megadrive"],
  "genesis": ["genesis", "mega drive"],
  "dreamcast": ["dreamcast", "dc"],
  "sega saturn": ["saturn"],
  "game gear": ["game gear", "gg"],
  "xbox": ["xbox"],
  "xbox 360": ["xbox 360", "x360"],
};

/**
 * Resolve a platform name (which may be a slug/abbreviation like "gba") to its
 * canonical key in PLATFORM_KEYWORDS, plus all keywords that belong to it.
 * Returns { canonicalKeys: Set of platform keys that match, allKeywords: all keywords for this platform }
 */
function resolveTargetPlatform(platformName: string): { canonicalKeys: Set<string>; allKeywords: string[] } {
  const pLower = platformName.toLowerCase();
  const canonicalKeys = new Set<string>();
  const allKeywords: string[] = [];

  // Direct match (e.g., "game boy advance")
  if (PLATFORM_KEYWORDS[pLower]) {
    canonicalKeys.add(pLower);
    allKeywords.push(...PLATFORM_KEYWORDS[pLower]);
  }

  // Reverse lookup: if platformName is itself a keyword value (e.g., "gba" → "game boy advance")
  for (const [platform, keywords] of Object.entries(PLATFORM_KEYWORDS)) {
    if (keywords.some((kw) => kw.toLowerCase() === pLower)) {
      canonicalKeys.add(platform);
      allKeywords.push(...keywords);
    }
  }

  // Also add the platform name itself as a keyword (so "gba" matches "gba" in title)
  if (!allKeywords.includes(pLower)) allKeywords.push(pLower);

  return { canonicalKeys, allKeywords: Array.from(new Set(allKeywords)) };
}

/** Normalize a title for platform keyword matching: replace dots/underscores/hyphens with spaces */
const normalizeForKeywords = (s: string) => s.toLowerCase().replace(/[._\-]+/g, " ").replace(/\s+/g, " ");

// Keywords that indicate a re-release FORMAT (not native ROM).
const FORMAT_OVERRIDE_KEYWORDS: Record<string, string[]> = {
  "wii": ["virtual console", "wiiware", "wii virtual console"],
};

// Pre-compiled regex cache for keyword matching (avoids recompiling per result)
const keywordRegexCache = new Map<string, RegExp>();
function kwRegex(keyword: string): RegExp {
  let re = keywordRegexCache.get(keyword);
  if (!re) {
    re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    keywordRegexCache.set(keyword, re);
  }
  return re;
}

/** Check if a result title mentions a DIFFERENT platform than the one requested */
export function hasPlatformMismatch(title: string, platformName?: string): boolean {
  if (!platformName) return false;
  // Normalize title so "Virtual.Console" matches "virtual console"
  const tNorm = normalizeForKeywords(title);

  const target = resolveTargetPlatform(platformName);

  // Check format override keywords first — these always indicate a specific platform
  // regardless of what other platform keywords appear in the title
  for (const [platform, keywords] of Object.entries(FORMAT_OVERRIDE_KEYWORDS)) {
    if (target.canonicalKeys.has(platform)) continue; // Skip if target IS this platform
    for (const kw of keywords) {
      if (kwRegex(kw).test(tNorm)) return true; // Always block — no target keyword exception
    }
  }

  // Detect Nintendo Switch title IDs (e.g. [0100300012F2A000]) — these are always Switch games
  if (!target.canonicalKeys.has("nintendo switch")) {
    if (/\[01[0-9A-Fa-f]{14}\]/.test(title)) return true;
  }

  // Find keywords for OTHER platforms that appear in the title
  for (const [platform, keywords] of Object.entries(PLATFORM_KEYWORDS)) {
    // Skip platforms that belong to the target
    if (target.canonicalKeys.has(platform)) continue;

    for (const kw of keywords) {
      // Skip format override keywords (already handled above)
      if (Object.values(FORMAT_OVERRIDE_KEYWORDS).some((fk) => fk.includes(kw))) continue;

      if (kwRegex(kw).test(tNorm)) {
        // Make sure the target platform's keywords don't also match (e.g. "Wii" is in "Wii U")
        const targetMatches = target.allKeywords.some((tk) => kwRegex(tk).test(tNorm));
        if (!targetMatches) return true;
      }
    }
  }
  return false;
}

/** Check if a result title is relevant to the game we're searching for */
function isTitleRelevant(title: string, gameName: string): boolean {
  const normalize = (s: string) => stripAccents(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const t = normalize(title);

  // Build full-name variants (including subtitle)
  const fullNames = [gameName];
  const simple = gameName.replace(/\s*(Version|Edition|Special)\s*/gi, " ").replace(/\s+/g, " ").trim();
  if (simple !== gameName) fullNames.push(simple);

  // Also add "Name, The" variants for ROM database naming convention
  for (const n of [...fullNames]) {
    const m = n.match(/^(The|A|An)\s+(.+)$/i);
    if (m) fullNames.push(`${m[2]} ${m[1]}`);
  }

  const normalizedFull = Array.from(new Set(fullNames.map(normalize))).filter(Boolean);

  // Check full name match first (most reliable)
  if (normalizedFull.some((name) => t.includes(name))) return true;

  // If game has a subtitle (colon-separated), require BOTH the franchise name AND
  // at least some subtitle words. This prevents "The Legend of Zelda" alone from
  // matching "The Legend of Zelda: Breath of the Wild" when searching for "A Link to the Past".
  const colonIdx = gameName.indexOf(":");
  if (colonIdx > 0) {
    const franchise = normalize(gameName.substring(0, colonIdx));
    const subtitle = normalize(gameName.substring(colonIdx + 1));
    if (franchise && subtitle && t.includes(franchise)) {
      // Extract significant words from subtitle (skip very short words)
      const subtitleWords = subtitle.split(" ").filter((w) => w.length >= 3);
      if (subtitleWords.length > 0) {
        // Require at least half the significant subtitle words to appear in the title
        const threshold = Math.max(1, Math.ceil(subtitleWords.length * 0.4));
        const matched = subtitleWords.filter((w) => t.includes(w)).length;
        if (matched >= threshold) return true;
      }
      // Franchise matched but subtitle didn't — NOT relevant
      return false;
    }
  }

  // Fallback for non-subtitle names: try franchise/clean name
  const clean = gameName.split(":")[0].trim();
  const cleanSimple = clean.replace(/\s*(Version|Edition|Special)\s*/gi, " ").replace(/\s+/g, " ").trim();
  const fallbackNames = [clean, cleanSimple];
  for (const n of [...fallbackNames]) {
    const m = n.match(/^(The|A|An)\s+(.+)$/i);
    if (m) fallbackNames.push(`${m[2]} ${m[1]}`);
  }
  const normalizedFallback = Array.from(new Set(fallbackNames.map(normalize))).filter(Boolean);
  return normalizedFallback.some((name) => t.includes(name));
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
    // Limit query variants to max 3 to reduce Prowlarr API calls
    const queries = this.buildQueries(gameName, platformName, searchTemplate).slice(0, 3);
    const seen = new Set<string>();
    const all: ProwlarrRelease[] = [];

    for (const q of queries) {
      // Run category search first; only run uncategorized if category returned 0 results (Issue #6)
      const cat = await this.search(q, GAME_CATEGORIES);
      let added = 0;
      for (const r of cat) {
        const key = r.guid || `${r.title}-${r.indexer}-${r.size}`;
        if (!seen.has(key)) { seen.add(key); all.push(r); added++; }
      }

      if (cat.length === 0) {
        const noCat = await this.search(q);
        for (const r of noCat) {
          const key = r.guid || `${r.title}-${r.indexer}-${r.size}`;
          if (!seen.has(key)) { seen.add(key); all.push(r); added++; }
        }
        console.log(`[Prowlarr] "${q}": ${cat.length} cat + fallback uncategorized, ${added} new (${all.length} total)`);
      } else {
        console.log(`[Prowlarr] "${q}": ${cat.length} cat results, ${added} new (${all.length} total)`);
      }
    }

    const maxSize = maxSizeMb > 0 ? maxSizeMb * 1024 * 1024 : Infinity;
    const blocked: Record<string, string[]> = { seeders: [], relevance: [], extension: [], wrongExt: [], platform: [] };
    const filtered = all.filter((r) => {
      if (!validUrl(r.downloadUrl, "http://", "https://") && !validUrl(r.magnetUrl, "magnet:", "http")) return false;
      if (r.protocol !== "usenet") {
        const effectiveMin = Math.max(minSeeders, 1);
        if ((r.seeders ?? 0) < effectiveMin) { blocked.seeders.push(r.title); return false; }
      }
      if (r.size > maxSize) return false;
      if (!isTitleRelevant(r.title, gameName)) { blocked.relevance.push(r.title); return false; }
      if (hasBlockedExtension(r.title)) { blocked.extension.push(r.title); return false; }
      if (!matchesPlatformExtensions(r.title, platformName)) { blocked.wrongExt.push(r.title); return false; }
      if (hasPlatformMismatch(r.title, platformName)) { blocked.platform.push(r.title); return false; }
      return true;
    });

    // Log blocked results as summary instead of per-result
    const totalBlocked = Object.values(blocked).reduce((s, a) => s + a.length, 0);
    if (totalBlocked > 0) {
      const parts: string[] = [];
      if (blocked.seeders.length) parts.push(`${blocked.seeders.length} low seeders`);
      if (blocked.relevance.length) parts.push(`${blocked.relevance.length} irrelevant`);
      if (blocked.extension.length) parts.push(`${blocked.extension.length} bad extension`);
      if (blocked.wrongExt.length) parts.push(`${blocked.wrongExt.length} wrong platform ext`);
      if (blocked.platform.length) parts.push(`${blocked.platform.length} wrong platform`);
      console.log(`[Prowlarr] Blocked ${totalBlocked}: ${parts.join(", ")}`);
    }

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

    // Get short platform abbreviation for better search results
    const platAbbrev = platform ? (PLATFORM_KEYWORDS[platform.toLowerCase()]?.[0] || platform) : undefined;

    if (template) q.push(template.replace("{game_name}", name).replace("{platform}", platform || "").trim());
    if (platform) q.push(`${name} ${platform}`);
    if (platAbbrev && platAbbrev !== platform) q.push(`${name} ${platAbbrev}`);
    q.push(name);
    if (clean !== name) { if (platform) q.push(`${clean} ${platform}`); if (platAbbrev && platAbbrev !== platform) q.push(`${clean} ${platAbbrev}`); q.push(clean); }
    if (simple !== clean) { if (platform) q.push(`${simple} ${platform}`); q.push(simple); }
    if (ascii !== (simple || clean)) { if (platform) q.push(`${ascii} ${platform}`); q.push(ascii); }

    return Array.from(new Set(q));
  }

  /**
   * Rewrite a Prowlarr download URL to use our configured base URL.
   * Prowlarr returns download URLs with its own hostname (e.g., 192.168.1.3:9696)
   * which may differ from how Rommseer reaches Prowlarr (e.g., prowlarr:9696).
   */
  private rewriteProwlarrUrl(downloadUrl: string): string | null {
    // Prowlarr download URLs look like: http://host:port/{indexerId}/download?apikey=...&link=...
    // Match any URL with /{number}/download pattern
    const match = downloadUrl.match(/^https?:\/\/[^/]+(\/\d+\/download\?.+)$/);
    if (match) {
      const rewritten = `${this.baseUrl}${match[1]}`;
      if (rewritten !== downloadUrl) {
        console.log(`[Prowlarr] Rewriting download URL to use configured base URL`);
      }
      return rewritten;
    }
    return null;
  }

  /**
   * Download a .torrent/.nzb file through Prowlarr.
   * Returns { type: "file", data: Buffer } for binary files,
   * or { type: "magnet", url: string } if the download redirects to a magnet link
   * (common with public indexers like LimeTorrents).
   */
  async downloadFile(downloadUrl: string, indexerId?: number): Promise<DownloadFileResult | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      // Rewrite Prowlarr download URLs to use our configured base URL
      const url = this.rewriteProwlarrUrl(downloadUrl) || downloadUrl;
      console.log(`[Prowlarr] Downloading: ${sanitizeUrl(url).substring(0, 120)}...`);

      // Use redirect: "manual" to catch magnet: redirects
      // (Node.js fetch crashes on non-HTTP redirect targets)
      const res = await fetch(url, {
        headers: { "X-Api-Key": this.apiKey },
        redirect: "manual",
        signal: controller.signal,
      });

      // Handle redirects — check if it's a magnet: link
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (location?.startsWith("magnet:")) {
          console.log(`[Prowlarr] Download redirected to magnet link!`);
          return { type: "magnet", url: location };
        }
        if (location?.startsWith("http")) {
          // Follow HTTP redirects manually
          console.log(`[Prowlarr] Following redirect to: ${location.substring(0, 100)}...`);
          const res2 = await fetch(location, {
            headers: { "X-Api-Key": this.apiKey },
            redirect: "manual",
            signal: controller.signal,
          });
          // Check for second-level magnet redirect
          if (res2.status >= 300 && res2.status < 400) {
            const loc2 = res2.headers.get("location");
            if (loc2?.startsWith("magnet:")) {
              console.log(`[Prowlarr] Second redirect to magnet link!`);
              return { type: "magnet", url: loc2 };
            }
            console.error(`[Prowlarr] Too many redirects: ${loc2?.substring(0, 80)}`);
            return null;
          }
          if (res2.ok) {
            const buf = Buffer.from(await res2.arrayBuffer());
            if (buf.length > 100) return { type: "file", data: buf };
            console.error(`[Prowlarr] Downloaded file too small (${buf.length} bytes)`);
          }
          return null;
        }
        console.error(`[Prowlarr] Unsupported redirect: ${location?.substring(0, 100)}`);
        return null;
      }

      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 100) return { type: "file", data: buf };
        console.error(`[Prowlarr] Downloaded file too small (${buf.length} bytes)`);
        return null;
      }

      const errText = await res.text().catch(() => "");
      console.error(`[Prowlarr] Download returned ${res.status}: ${errText.substring(0, 200)}`);
      return null;
    } catch (e: unknown) {
      const err = e instanceof Error ? e : null;
      const cause = err && "cause" in err ? (err.cause as Error)?.message || String(err.cause) : "unknown";
      console.error(`[Prowlarr] Download error: ${err?.message || e} (cause: ${cause})`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Tell Prowlarr to grab a release and send it to Prowlarr's own configured download client.
   * This bypasses Rommseer having to download files entirely — Prowlarr handles everything.
   * Requires a download client (qBittorrent/SABnzbd) to be configured in Prowlarr.
   */
  async grabRelease(release: ProwlarrRelease): Promise<boolean> {
    try {
      console.log(`[Prowlarr] Attempting Prowlarr-native grab for "${release.title}" via indexer ${release.indexer}`);
      const res = await fetch(`${this.baseUrl}/api/v1/search`, {
        method: "POST",
        headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          guid: release.guid,
          indexerId: release.indexerId,
        }),
      });
      if (res.ok) {
        console.log(`[Prowlarr] Prowlarr-native grab succeeded`);
        return true;
      }
      const errText = await res.text().catch(() => "");
      console.log(`[Prowlarr] Prowlarr-native grab returned ${res.status}: ${errText.substring(0, 200)}`);
      return false;
    } catch (e) {
      console.log(`[Prowlarr] Prowlarr-native grab failed: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }
}

export async function getProwlarrClient(): Promise<ProwlarrClient | null> {
  const s = await prisma.settings.findUnique({ where: { id: 1 } });
  return s?.prowlarrUrl && s?.prowlarrApiKey ? new ProwlarrClient(s.prowlarrUrl, s.prowlarrApiKey) : null;
}

/**
 * Get valid ROM extensions for a platform name (supports slugs like "gba").
 * Returns null if platform is unknown (no extension filtering should be applied).
 */
export function getValidExtensionsForPlatform(platformName: string): string[] | null {
  const pLower = platformName.toLowerCase();

  // Direct match
  if (PLATFORM_EXTENSIONS[pLower]) return PLATFORM_EXTENSIONS[pLower];

  // Reverse lookup via PLATFORM_KEYWORDS: "gba" → "game boy advance" → extensions
  for (const [platform, keywords] of Object.entries(PLATFORM_KEYWORDS)) {
    if (keywords.some((kw) => kw.toLowerCase() === pLower) && PLATFORM_EXTENSIONS[platform]) {
      return PLATFORM_EXTENSIONS[platform];
    }
  }

  return null;
}

// Re-export formatBytes from utils for backward compatibility
export { formatBytes } from "@/lib/utils";
