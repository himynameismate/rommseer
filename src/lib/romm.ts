import { prisma } from "@/lib/db";
import { logger } from "@/lib/utils";
import { io } from "socket.io-client";

interface RomMPlatform {
  id: number;
  slug: string;
  fs_slug?: string;
  name: string;
  rom_count: number;
}

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

/**
 * RomM API client supporting two authentication modes:
 *
 * 1. **API Key (preferred)**: RomM 4.8.0+ client tokens with `rmm_` prefix.
 *    Sent directly as `Authorization: Bearer rmm_<token>`. No OAuth flow needed.
 *
 * 2. **Username/Password (legacy fallback)**: OAuth2 password grant via
 *    POST /api/token. Used only when no API key is provided.
 */
export class RomMClient {
  private baseUrl: string;
  private apiKey: string | null;
  private username: string;
  private password: string;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt: number = 0;

  private static readonly TOKEN_REFRESH_BUFFER_MS = 60_000;
  private static readonly ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000;

  constructor(baseUrl: string, options: { apiKey?: string; username?: string; password?: string } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey || null;
    this.username = options.username || "";
    this.password = options.password || "";
  }

  /** Whether this client uses a static API key (no token refresh needed). */
  private get usesApiKey(): boolean {
    return !!this.apiKey;
  }

  /** Get the bearer token to use for requests. */
  private getBearerToken(): string | null {
    if (this.usesApiKey) return this.apiKey;
    return this.accessToken;
  }

  /** Obtain a new access token using username/password (OAuth2 password grant). */
  private async authenticate(): Promise<void> {
    const scopes = [
      "me.read",
      "roms.read",
      "platforms.read",
      "assets.read",
      "tasks.run",
    ];

    const body = new URLSearchParams({
      grant_type: "password",
      username: this.username,
      password: this.password,
      scope: scopes.join(" "),
    });

    const response = await fetch(`${this.baseUrl}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `RomM authentication failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`
      );
    }

    interface TokenResponse {
      access_token: string;
      refresh_token: string;
      token_type: string;
    }

    const data: TokenResponse = await response.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.tokenExpiresAt = Date.now() + RomMClient.ACCESS_TOKEN_LIFETIME_MS;
    logger.log("[RomM] Authenticated via OAuth2 token");
  }

  /** Use the refresh token to get a new access token without re-sending credentials. */
  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) return false;

    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
      });

      const response = await fetch(`${this.baseUrl}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!response.ok) {
        logger.log("[RomM] Refresh token expired or invalid, re-authenticating");
        return false;
      }

      interface TokenResponse {
        access_token: string;
        refresh_token: string;
        token_type: string;
      }

      const data: TokenResponse = await response.json();
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token;
      this.tokenExpiresAt = Date.now() + RomMClient.ACCESS_TOKEN_LIFETIME_MS;
      logger.log("[RomM] Token refreshed via refresh_token");
      return true;
    } catch {
      return false;
    }
  }

  /** Ensure we have a valid bearer token. API key mode is always valid; OAuth mode refreshes as needed. */
  private async ensureToken(): Promise<void> {
    // API key mode — always valid, no refresh needed
    if (this.usesApiKey) return;

    // OAuth: token still valid
    if (this.accessToken && Date.now() < this.tokenExpiresAt - RomMClient.TOKEN_REFRESH_BUFFER_MS) {
      return;
    }

    // Try refreshing first
    if (this.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) return;
    }

    // Full re-authentication
    await this.authenticate();
  }

  private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    await this.ensureToken();

    const url = `${this.baseUrl}/api${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.getBearerToken()}`,
    };

    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...((options?.headers as Record<string, string>) || {}) },
    });

    // On 401, try re-authenticating once (only for OAuth mode)
    if (response.status === 401 && !this.usesApiKey) {
      this.accessToken = null;
      this.refreshToken = null;
      this.tokenExpiresAt = 0;
      await this.authenticate();

      const retryResponse = await fetch(url, {
        ...options,
        headers: {
          ...headers,
          Authorization: `Bearer ${this.getBearerToken()}`,
          ...((options?.headers as Record<string, string>) || {}),
        },
      });

      if (!retryResponse.ok) {
        throw new Error(`RomM API error: ${retryResponse.status} ${retryResponse.statusText}`);
      }
      return retryResponse.json();
    }

    if (!response.ok) {
      throw new Error(`RomM API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.fetch<RomMPlatform[]>("/platforms");
      return true;
    } catch (error) {
      logger.error("RomM connection test failed:", error);
      return false;
    }
  }

  async getPlatforms(): Promise<RomMPlatform[]> {
    return this.fetch<RomMPlatform[]>("/platforms");
  }

  async getRoms(platformId?: number, search?: string): Promise<RomMRom[]> {
    const params = new URLSearchParams();
    if (platformId) params.set("platform_id", String(platformId));
    if (search) params.set("search_term", search);
    // Request a large page to avoid needing to paginate (RomM 4.x paginates by default)
    params.set("limit", "10000");
    params.set("size", "10000");
    const query = params.toString();
    // RomM 4.x changed /api/roms to return a paginated object { items: [...], total, page, size }
    // instead of a plain array. Handle both formats for compatibility.
    const data = await this.fetch<RomMRom[] | { items: RomMRom[] }>(`/roms${query ? `?${query}` : ""}`);
    return Array.isArray(data) ? data : (data.items ?? []);
  }

  async getRom(id: number): Promise<RomMRom> {
    return this.fetch<RomMRom>(`/roms/${id}`);
  }

  /**
   * Trigger a library scan in RomM via Socket.IO.
   * RomM uses websocket events (not REST) to trigger scans.
   * @param platformIds - Optional list of platform IDs to scan. Empty = scan all.
   * @param scanType - "quick" (default) or "complete"
   */
  async triggerScan(platformIds: number[] = [], scanType: "quick" | "complete" = "quick"): Promise<void> {
    await this.ensureToken();

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.disconnect();
        // scan:done not received within 10s — scan likely still running in background
        logger.log(`[RomM] Scan timed out waiting for scan:done — scan likely still running in RomM`);
        resolve();
      }, 10_000);

      const socket = io(this.baseUrl, {
        path: "/ws/socket.io/",
        transports: ["polling", "websocket"],
        extraHeaders: {
          Authorization: `Bearer ${this.getBearerToken()}`,
        },
        withCredentials: true,
        timeout: 10_000,
      });

      socket.on("connect", () => {
        logger.log(`[RomM] Socket connected, emitting scan event (type=${scanType}, platforms=${platformIds.join(",") || "all"})`);
        socket.emit("scan", {
          platforms: platformIds,
          type: scanType,
          roms_ids: [],
          apis: ["igdb"],
          launchbox_remote_enabled: true,
        });
        // Stay connected — wait for scan:done or the 10s timeout above
      });

      socket.on("scan:done", () => {
        clearTimeout(timeout);
        socket.disconnect();
        logger.log(`[RomM] Scan completed`);
        resolve();
      });

      socket.on("connect_error", (err) => {
        clearTimeout(timeout);
        socket.disconnect();
        logger.error(`[RomM] Socket connection error:`, err.message);
        reject(new Error(`RomM socket connection failed: ${err.message}`));
      });
    });
  }

  /** Trigger a scan of a specific platform in RomM. */
  async scanPlatform(platformId: number): Promise<void> {
    try {
      await this.triggerScan([platformId], "quick");
    } catch (e) {
      logger.error(`[RomM] Platform scan failed:`, e instanceof Error ? e.message : e);
    }
  }

  /** Trigger a full library scan in RomM. */
  async scanAll(): Promise<void> {
    try {
      await this.triggerScan([], "quick");
    } catch (e) {
      logger.error(`[RomM] Full scan failed:`, e instanceof Error ? e.message : e);
    }
  }
}

export async function getRomMClient(): Promise<RomMClient | null> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.rommUrl) return null;
  return new RomMClient(settings.rommUrl, {
    apiKey: settings.rommApiKey || undefined,
    username: settings.rommUsername || undefined,
    password: settings.rommPassword || undefined,
  });
}
