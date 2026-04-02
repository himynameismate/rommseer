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

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

const TOKEN_REFRESH_BUFFER_MS = 60_000; // Refresh 1 minute before expiry
const ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000; // 15 minutes

/**
 * RomM API client using OAuth2 bearer token authentication.
 *
 * Authenticates via POST /api/token with username/password to obtain
 * an access_token (15 min) and refresh_token (2 weeks). All subsequent
 * requests use Authorization: Bearer <access_token>.
 */
export class RomMClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.username = username;
    this.password = password;
  }

  /** Obtain a new access token using username/password. */
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

    const data: TokenResponse = await response.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.tokenExpiresAt = Date.now() + ACCESS_TOKEN_LIFETIME_MS;
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

      const data: TokenResponse = await response.json();
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token;
      this.tokenExpiresAt = Date.now() + ACCESS_TOKEN_LIFETIME_MS;
      logger.log("[RomM] Token refreshed via refresh_token");
      return true;
    } catch {
      return false;
    }
  }

  /** Ensure we have a valid access token, refreshing or re-authenticating as needed. */
  private async ensureToken(): Promise<void> {
    // Token still valid
    if (this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
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
      Authorization: `Bearer ${this.accessToken}`,
    };

    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...((options?.headers as Record<string, string>) || {}) },
    });

    // On 401, try re-authenticating once
    if (response.status === 401) {
      this.accessToken = null;
      this.refreshToken = null;
      this.tokenExpiresAt = 0;
      await this.authenticate();

      const retryResponse = await fetch(url, {
        ...options,
        headers: {
          ...headers,
          Authorization: `Bearer ${this.accessToken}`,
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
    const query = params.toString();
    return this.fetch<RomMRom[]>(`/roms${query ? `?${query}` : ""}`);
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
        // Scan was emitted, just resolve even if we didn't get confirmation
        logger.log(`[RomM] Scan emit timed out waiting for response, scan likely started`);
        resolve();
      }, 10_000);

      const socket = io(this.baseUrl, {
        path: "/ws/socket.io/",
        transports: ["polling", "websocket"],
        extraHeaders: {
          Authorization: `Bearer ${this.accessToken}`,
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

        // Give RomM a moment to acknowledge, then disconnect
        setTimeout(() => {
          clearTimeout(timeout);
          socket.disconnect();
          logger.log(`[RomM] Scan triggered successfully`);
          resolve();
        }, 2000);
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
  return new RomMClient(settings.rommUrl, settings.rommUsername, settings.rommPassword);
}
