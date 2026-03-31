/**
 * Cached client instances with TTL.
 * Avoids re-reading Settings and re-creating clients on every call within a request cycle.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/utils";
import { SABnzbdClient } from "@/lib/sabnzbd";
import { QBittorrentClient } from "@/lib/qbittorrent";
import { RomMClient } from "@/lib/romm";
import { ProwlarrClient } from "@/lib/prowlarr";

interface CacheEntry<T> {
  instance: T;
  expiresAt: number;
}

const CACHE_TTL = 30_000; // 30 seconds

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let settingsCache: CacheEntry<any> | null = null;
let sabCache: CacheEntry<SABnzbdClient | null> | null = null;
let qbitCache: CacheEntry<QBittorrentClient | null> | null = null;
let rommCache: CacheEntry<RomMClient | null> | null = null;
let prowlarrCache: CacheEntry<ProwlarrClient | null> | null = null;

async function getCachedSettings() {
  if (settingsCache && Date.now() < settingsCache.expiresAt) return settingsCache.instance;
  const s = await prisma.settings.findUnique({ where: { id: 1 } });
  settingsCache = { instance: s, expiresAt: Date.now() + CACHE_TTL };
  return s;
}

export async function getCachedSABnzbdClient(): Promise<SABnzbdClient | null> {
  if (sabCache && Date.now() < sabCache.expiresAt) return sabCache.instance;
  const settings = await getCachedSettings();
  const instance = settings?.sabnzbdUrl && settings?.sabnzbdApiKey
    ? new SABnzbdClient(settings.sabnzbdUrl, settings.sabnzbdApiKey)
    : null;
  sabCache = { instance, expiresAt: Date.now() + CACHE_TTL };
  return instance;
}

export async function getCachedQBittorrentClient(): Promise<QBittorrentClient | null> {
  if (qbitCache && Date.now() < qbitCache.expiresAt) return qbitCache.instance;
  const settings = await getCachedSettings();
  const instance = settings?.qbitUrl && settings?.qbitUsername && settings?.qbitPassword
    ? new QBittorrentClient(settings.qbitUrl, settings.qbitUsername, settings.qbitPassword)
    : null;
  qbitCache = { instance, expiresAt: Date.now() + CACHE_TTL };
  return instance;
}

export async function getCachedRomMClient(): Promise<RomMClient | null> {
  if (rommCache && Date.now() < rommCache.expiresAt) return rommCache.instance;
  const settings = await getCachedSettings();
  const instance = settings?.rommUrl
    ? new RomMClient(settings.rommUrl, settings.rommUsername, settings.rommPassword)
    : null;
  rommCache = { instance, expiresAt: Date.now() + CACHE_TTL };
  return instance;
}

export async function getCachedProwlarrClient(): Promise<ProwlarrClient | null> {
  if (prowlarrCache && Date.now() < prowlarrCache.expiresAt) return prowlarrCache.instance;
  const settings = await getCachedSettings();
  const instance = settings?.prowlarrUrl && settings?.prowlarrApiKey
    ? new ProwlarrClient(settings.prowlarrUrl, settings.prowlarrApiKey)
    : null;
  prowlarrCache = { instance, expiresAt: Date.now() + CACHE_TTL };
  return instance;
}

/** Debounced scan trigger - if multiple scans requested within 5s, only run one. */
let pendingScanTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingScanPlatformId: number | null = null;

export function debouncedScan(romm: RomMClient, platformId?: number): void {
  if (pendingScanTimeout) {
    clearTimeout(pendingScanTimeout);
    if (pendingScanPlatformId !== undefined && platformId !== pendingScanPlatformId) {
      platformId = undefined;
    }
  }
  pendingScanPlatformId = platformId ?? null;

  pendingScanTimeout = setTimeout(async () => {
    pendingScanTimeout = null;
    pendingScanPlatformId = null;
    try {
      if (platformId) {
        logger.log(`[RomM] Debounced scan: platform ${platformId}`);
        await romm.scanPlatform(platformId);
      } else {
        logger.log(`[RomM] Debounced scan: full`);
        await romm.scanAll();
      }
    } catch (e) {
      logger.error(`[RomM] Debounced scan failed:`, e);
    }
  }, 5000);
}
