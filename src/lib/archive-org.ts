/**
 * Internet Archive client for searching and downloading ROMs directly.
 * Uses the IA Advanced Search API and direct download URLs.
 * No external dependencies — just fetch() against archive.org endpoints.
 */
import { logger } from "@/lib/utils";
import * as fs from "fs";
import * as path from "path";

const DOWNLOADS_PATH = "/downloads";

/** A single item returned from IA Advanced Search */
export interface IASearchResult {
  identifier: string;
  title: string;
  description?: string;
  mediatype?: string;
  downloads?: number;
}

/** A file within an IA item */
interface IAFile {
  name: string;
  size: string;
  format: string;
  source?: string;
}

/** Result of downloading a file from IA */
export interface IADownloadResult {
  /** Absolute path where the file was saved */
  filePath: string;
  /** Original filename */
  fileName: string;
  /** Size in bytes */
  size: number;
}

// Platform abbreviations for IA search queries
const IA_PLATFORM_TERMS: Record<string, string[]> = {
  "game boy advance": ["gba", "game boy advance", "gameboy advance"],
  "game boy color": ["gbc", "game boy color"],
  "game boy": ["gb", "game boy", "gameboy"],
  "nintendo ds": ["nds", "nintendo ds"],
  "nintendo 3ds": ["3ds", "nintendo 3ds"],
  "nintendo entertainment system": ["nes", "nintendo"],
  "super nintendo entertainment system": ["snes", "super nintendo"],
  "nintendo 64": ["n64", "nintendo 64"],
  "gamecube": ["gamecube", "gcn"],
  "wii": ["wii"],
  "nintendo switch": ["switch", "nintendo switch"],
  "playstation": ["psx", "ps1", "playstation"],
  "playstation 2": ["ps2"],
  "playstation portable": ["psp"],
  "sega mega drive/genesis": ["genesis", "mega drive", "sega genesis"],
  "sega master system": ["sms", "master system"],
  "dreamcast": ["dreamcast"],
  "game gear": ["game gear"],
};

// Valid ROM extensions per platform (subset for filtering IA files)
const IA_ROM_EXTENSIONS: Record<string, string[]> = {
  "game boy advance": [".gba"],
  "game boy color": [".gbc", ".gb"],
  "game boy": [".gb"],
  "nintendo ds": [".nds"],
  "nintendo 3ds": [".3ds", ".cia"],
  "nintendo entertainment system": [".nes"],
  "super nintendo entertainment system": [".sfc", ".smc"],
  "nintendo 64": [".n64", ".z64", ".v64"],
  "gamecube": [".iso", ".gcm", ".gcz", ".rvz"],
  "wii": [".iso", ".wbfs", ".rvz"],
  "nintendo switch": [".nsp", ".xci", ".nsz"],
  "playstation": [".bin", ".cue", ".iso", ".chd", ".pbp"],
  "playstation 2": [".iso", ".chd"],
  "playstation portable": [".iso", ".cso", ".pbp"],
  "sega mega drive/genesis": [".md", ".gen", ".bin"],
  "sega master system": [".sms"],
  "dreamcast": [".gdi", ".cdi", ".chd"],
  "game gear": [".gg"],
};

// Always allow archives (they often contain ROMs)
const ARCHIVE_EXTENSIONS = [".zip", ".7z", ".rar"];

// Words in IA item titles/identifiers that indicate a low-quality dump
const BAD_ITEM_PATTERNS = [
  /\bprototype?\b/i,
  /\bproto\b/i,
  /\bbeta\b/i,
  /\bhack\b/i,
  /\bpirate\b/i,
  /\bbootleg\b/i,
  /\bchinese\b/i,
  /\bchina\b/i,
  /\bunlicensed\b/i,
  /\brepro\b/i,
];

// Words/patterns in IA item titles that indicate a good dump
const GOOD_ITEM_PATTERNS = [
  /\busa\b/i,
  /\bworld\b/i,
  /\beurope\b/i,
  /\bmulti\b/i,
  /\benglish\b/i,
  /\ben,/i,   // multi-lang tag like "En,Fr,De"
];

// ROM filename region tags that indicate a preferred dump (no-intro style)
const GOOD_FILE_REGIONS = [
  /\(usa\)/i,
  /\(world\)/i,
  /\(europe\)/i,
  /\(en\)/i,
  /\ben,/i,         // language list starting with En
  /\(u\)/i,         // old-style USA tag
  /\(e\)/i,         // old-style Europe tag
  /\(ue\)/i,        // USA+Europe combo
  /\(uw\)/i,        // USA+World combo
];

// ROM filename patterns that indicate a bad dump
const BAD_FILE_REGIONS = [
  /\(china\)/i,
  /\(zh\)/i,
  /\(c\)(?!\+)/i,   // (C) but not (C+something) — old-style China tag
  /\(japan\)/i,
  /\(j\)/i,         // old-style Japan tag
  /\(korea\)/i,
  /\(k\)/i,
  /\bproto(type)?\b/i,
  /\bbeta\b/i,
  /\bhack\b/i,
  /\(unl\)/i,       // unlicensed
];

/**
 * Score an IA search result item for ROM quality.
 * Higher = better. Negative = should be filtered out.
 */
function scoreIaItem(item: IASearchResult): number {
  const haystack = `${item.title} ${item.identifier}`.toLowerCase();
  let score = 0;

  for (const pat of BAD_ITEM_PATTERNS) {
    if (pat.test(haystack)) score -= 50;
  }
  for (const pat of GOOD_ITEM_PATTERNS) {
    if (pat.test(haystack)) score += 20;
  }

  // Boost by (log) download count — popular items tend to be better dumps
  if (item.downloads && item.downloads > 0) {
    score += Math.min(Math.log10(item.downloads) * 5, 25);
  }

  return score;
}

/**
 * Score a file within an IA item for region/quality preference.
 * Returns a bonus score (positive = good, negative = bad).
 */
function scoreFileRegion(fileName: string): number {
  let bonus = 0;
  for (const pat of GOOD_FILE_REGIONS) {
    if (pat.test(fileName)) {
      bonus += 30;
      break; // Only count once
    }
  }
  for (const pat of BAD_FILE_REGIONS) {
    if (pat.test(fileName)) {
      bonus -= 40;
      break; // Only count once
    }
  }
  return bonus;
}

/**
 * Search the Internet Archive for ROMs matching a game name and platform.
 * Uses the IA Advanced Search API (no authentication required).
 */
export async function searchArchiveOrg(
  gameName: string,
  platformName?: string,
): Promise<IASearchResult[]> {
  const platLower = platformName?.toLowerCase() || "";
  const platTerms = IA_PLATFORM_TERMS[platLower] || [];
  // Build a search query — prefer game name + platform keyword
  const platKeyword = platTerms[0] || platformName || "";

  // IA search: title contains the game name, mediatype is software
  // Try two queries: with platform keyword, then without
  const queries: string[] = [];
  if (platKeyword) {
    queries.push(`title:(${gameName}) AND (${platKeyword}) AND mediatype:software`);
  }
  queries.push(`title:(${gameName}) AND mediatype:software`);

  const seen = new Set<string>();
  const results: IASearchResult[] = [];

  for (const q of queries) {
    try {
      const params = new URLSearchParams({
        q,
        "fl[]": "identifier,title,description,mediatype,downloads",
        rows: "20",
        output: "json",
        sort: "downloads desc",
      });

      // IA uses fl[] repeated, URLSearchParams doesn't handle that well
      const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=description&fl[]=mediatype&fl[]=downloads&rows=20&output=json&sort=downloads+desc`;

      logger.log(`[ArchiveOrg] Searching: ${q}`);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        logger.error(`[ArchiveOrg] Search returned ${res.status}`);
        continue;
      }

      const data = await res.json() as {
        response: { docs: IASearchResult[] };
      };

      for (const doc of data.response.docs) {
        if (!seen.has(doc.identifier)) {
          seen.add(doc.identifier);
          results.push(doc);
        }
      }

      logger.log(`[ArchiveOrg] "${q}": ${data.response.docs.length} results (${results.length} total)`);

      // Always run both queries to maximise candidate pool — the generic query
      // often surfaces the correct item when the platform-specific one doesn't
    } catch (e) {
      logger.error(`[ArchiveOrg] Search error:`, e instanceof Error ? e.message : e);
    }
  }

  return results;
}

/**
 * Normalize a string for fuzzy matching: lowercase, strip non-alphanumeric, collapse spaces.
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Check if a filename is an exact match for the game (not a sequel/variant).
 * Returns a score bonus: +200 for exact match, +50 for "contains" match,
 * -100 if the filename contains the game name plus extra significant words (sequel).
 */
function scoreFileNameMatch(fileName: string, gameName: string): number {
  const normFile = normalizeForMatch(path.basename(fileName, path.extname(fileName)));
  const normGame = normalizeForMatch(gameName);

  if (!normFile.includes(normGame)) return 0; // No match at all — neutral

  // Check what comes after the game name in the filename
  const matchEnd = normFile.indexOf(normGame) + normGame.length;
  const after = normFile.substring(matchEnd).trim();

  if (!after) return 200; // Exact match (nothing after game name)

  // Check for sequel indicators: numbers, significant extra words
  const NOISE = /^(the|and|or|a|of|gba|gbc|nds|snes|nes|n64|rom|usa|world|europe|en|u|e)$/i;
  const words = after.split(/\s+/).filter((w) => w.length >= 2 && !NOISE.test(w));

  if (words.length === 0) return 150; // Only noise/platform words after — still a good match

  // Has significant extra words → likely a sequel or variant (e.g. "2 Black Hole Rising")
  // Check if starts with a number (strong sequel indicator)
  if (/^\d/.test(after)) return -100; // "Advance Wars 2" — definitely a sequel

  if (words.length >= 2) return -80; // Multiple extra words — likely different game

  return -30; // Single extra word — might be a subtitle, penalise mildly
}

/**
 * Get the list of files in an IA item and find the best ROM file for the target platform.
 * Returns the file metadata if a suitable ROM is found, null otherwise.
 */
export async function findRomInItem(
  identifier: string,
  platformName?: string,
  gameName?: string,
): Promise<{ fileName: string; size: number; downloadUrl: string } | null> {
  try {
    const url = `https://archive.org/metadata/${encodeURIComponent(identifier)}/files`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;

    const data = await res.json() as { result: IAFile[] };
    const files = data.result || [];

    // Get valid extensions for the target platform
    const platLower = platformName?.toLowerCase() || "";
    const validExts = IA_ROM_EXTENSIONS[platLower] || [];

    // Score each file: prefer platform-specific ROM extensions, then archives
    const candidates: { file: IAFile; score: number }[] = [];

    for (const file of files) {
      const ext = path.extname(file.name).toLowerCase();
      const size = parseInt(file.size, 10) || 0;

      // Skip tiny files (metadata, thumbnails, etc.)
      if (size < 1024) continue;

      // Skip IA metadata files
      if (file.source === "metadata" || file.format === "Metadata") continue;
      if (file.name.endsWith("_meta.xml") || file.name.endsWith("_files.xml")) continue;
      if (file.name.endsWith(".torrent")) continue;

      let score = 0;

      if (validExts.length > 0 && validExts.includes(ext)) {
        score = 100; // Exact platform match
      } else if (ARCHIVE_EXTENSIONS.includes(ext)) {
        score = 50; // Archive — might contain ROM
      } else {
        continue; // Not a ROM or archive, skip
      }

      // Boost by size (larger files are more likely to be the actual ROM)
      score += Math.min(size / (1024 * 1024), 10); // up to +10 for 10MB+

      // Boost/penalise based on region tags in the filename
      score += scoreFileRegion(file.name);

      // Boost/penalise based on how well the filename matches the requested game
      if (gameName) {
        score += scoreFileNameMatch(file.name, gameName);
      }

      candidates.push({ file, score });
    }

    if (candidates.length === 0) {
      logger.log(`[ArchiveOrg] No ROM files found in item "${identifier}" for platform "${platformName}"`);
      return null;
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // Log top candidates for debugging
    if (candidates.length > 1) {
      logger.log(`[ArchiveOrg] File candidates in "${identifier}":`);
      for (const c of candidates.slice(0, 5)) {
        const s = parseInt(c.file.size, 10) || 0;
        logger.log(`  score=${c.score.toFixed(0)}  "${c.file.name}" (${(s / 1024 / 1024).toFixed(1)} MB)`);
      }
    }

    const best = candidates[0].file;
    const size = parseInt(best.size, 10) || 0;

    logger.log(`[ArchiveOrg] Best file in "${identifier}": "${best.name}" (${(size / 1024 / 1024).toFixed(1)} MB)`);

    return {
      fileName: best.name,
      size,
      downloadUrl: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(best.name)}`,
    };
  } catch (e) {
    logger.error(`[ArchiveOrg] Failed to list files for "${identifier}":`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Download a file from the Internet Archive directly to /downloads/.
 * Returns the local file path on success, null on failure.
 */
export async function downloadFromArchiveOrg(
  downloadUrl: string,
  fileName: string,
  maxSizeMb: number = 0,
): Promise<IADownloadResult | null> {
  const safeName = path.basename(fileName); // Prevent path traversal
  const destPath = path.join(DOWNLOADS_PATH, safeName);

  // Validate destination is within /downloads
  const resolved = path.resolve(destPath);
  if (!resolved.startsWith(path.resolve(DOWNLOADS_PATH) + path.sep) && resolved !== path.resolve(DOWNLOADS_PATH)) {
    logger.error(`[ArchiveOrg] Path traversal detected: "${resolved}"`);
    return null;
  }

  try {
    logger.log(`[ArchiveOrg] Downloading: ${downloadUrl}`);

    const res = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(300000), // 5 minute timeout for large files
      redirect: "follow",
    });

    if (!res.ok) {
      logger.error(`[ArchiveOrg] Download returned ${res.status}`);
      return null;
    }

    // Check size from Content-Length header before downloading
    const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
    if (maxSizeMb > 0 && contentLength > maxSizeMb * 1024 * 1024) {
      logger.log(`[ArchiveOrg] File too large: ${(contentLength / 1024 / 1024).toFixed(1)} MB (max: ${maxSizeMb} MB)`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer.length < 1024) {
      logger.error(`[ArchiveOrg] Downloaded file too small (${buffer.length} bytes)`);
      return null;
    }

    // Ensure /downloads exists
    fs.mkdirSync(DOWNLOADS_PATH, { recursive: true });
    fs.writeFileSync(destPath, buffer);

    logger.log(`[ArchiveOrg] Saved: ${destPath} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

    return {
      filePath: destPath,
      fileName: safeName,
      size: buffer.length,
    };
  } catch (e) {
    logger.error(`[ArchiveOrg] Download failed:`, e instanceof Error ? e.message : e);
    // Clean up partial file
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Full search-and-download pipeline for the Internet Archive.
 * Searches for a game, finds the best ROM file, downloads it.
 * Returns the download result or null if nothing suitable was found.
 */
export async function searchAndDownloadFromIA(
  gameName: string,
  platformName?: string,
  maxSizeMb: number = 0,
): Promise<{
  result: IADownloadResult;
  identifier: string;
  itemTitle: string;
} | null> {
  const results = await searchArchiveOrg(gameName, platformName);
  if (!results.length) {
    logger.log(`[ArchiveOrg] No results for "${gameName}"`);
    return null;
  }

  const normalizedGame = normalizeForMatch(gameName);

  // Filter to relevant items (title must contain game name), then score and sort by quality.
  // Also penalise sequels at the item level (e.g. "Advance Wars 2" when searching "Advance Wars").
  const candidates = results
    .filter((item) => normalizeForMatch(item.title).includes(normalizedGame))
    .map((item) => {
      let score = scoreIaItem(item);
      // Penalise sequels: check what follows the game name in the item title
      score += scoreFileNameMatch(item.title, gameName);
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    logger.log(`[ArchiveOrg] No relevant results for "${gameName}"`);
    return null;
  }

  logger.log(
    `[ArchiveOrg] ${candidates.length} candidate(s) after relevance filter (sorted by quality):`,
  );
  for (const { item, score } of candidates.slice(0, 5)) {
    logger.log(`  score=${score.toFixed(1)}  "${item.title}"  (${item.identifier})`);
  }

  // Try up to 5 items in quality order
  for (let i = 0; i < Math.min(candidates.length, 5); i++) {
    const { item, score } = candidates[i];
    logger.log(`[ArchiveOrg] Checking item ${i + 1}: "${item.title}" (${item.identifier}, score=${score.toFixed(1)})`);

    const romFile = await findRomInItem(item.identifier, platformName, gameName);
    if (!romFile) continue;

    const downloaded = await downloadFromArchiveOrg(romFile.downloadUrl, romFile.fileName, maxSizeMb);
    if (!downloaded) continue;

    return {
      result: downloaded,
      identifier: item.identifier,
      itemTitle: item.title,
    };
  }

  logger.log(`[ArchiveOrg] No suitable ROM found across ${Math.min(candidates.length, 5)} items`);
  return null;
}
