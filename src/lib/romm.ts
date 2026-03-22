import { prisma } from "@/lib/db";
import { io } from "socket.io-client";

interface RomMPlatform {
  id: number;
  slug: string;
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

export class RomMClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private sessionCookie: string | null = null;
  private csrfToken: string | null = null;

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.username = username;
    this.password = password;
  }

  private async login(): Promise<void> {
    if (this.sessionCookie) return;

    const basicAuth = Buffer.from(`${this.username}:${this.password}`).toString("base64");

    const response = await fetch(`${this.baseUrl}/api/login`, {
      method: "POST",
      headers: { "Authorization": `Basic ${basicAuth}` },
      redirect: "manual",
    });

    // Extract session cookie
    const cookies: string[] = [];
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") {
        cookies.push(value.split(";")[0]);
      }
    });

    const sessionCookie = cookies.find((c) => c.startsWith("romm_session="));
    if (sessionCookie) {
      this.sessionCookie = sessionCookie;
    } else if (cookies.length > 0) {
      this.sessionCookie = cookies[0];
    }

    if (!this.sessionCookie) {
      throw new Error(`RomM login failed: ${response.status} ${response.statusText}`);
    }

    // Fetch CSRF token from heartbeat endpoint
    await this.refreshCsrfToken();
  }

  /** Get a fresh CSRF token from RomM's heartbeat endpoint. */
  private async refreshCsrfToken(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/heartbeat`, {
        headers: { Cookie: this.sessionCookie || "" },
      });
      res.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie" && value.includes("csrftoken")) {
          const cookiePart = value.split(";")[0]; // romm_csrftoken=...
          this.csrfToken = cookiePart.split("=").slice(1).join("=");
        }
      });
    } catch (e) {
      console.error("[RomM] Failed to get CSRF token:", e instanceof Error ? e.message : e);
    }
  }

  /** Build Cookie header string including session + CSRF cookies. */
  private getCookieHeader(): string {
    const parts = [this.sessionCookie];
    if (this.csrfToken) parts.push(`romm_csrftoken=${this.csrfToken}`);
    return parts.filter(Boolean).join("; ");
  }

  private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    await this.login();

    const url = `${this.baseUrl}/api${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Cookie: this.getCookieHeader(),
    };

    // Include CSRF token header for mutating requests
    const method = (options?.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && this.csrfToken) {
      headers["X-CSRFToken"] = this.csrfToken;
    }

    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...((options?.headers as Record<string, string>) || {}) },
    });

    // On 401/403, re-login and retry once
    if (response.status === 401 || response.status === 403) {
      this.sessionCookie = null;
      this.csrfToken = null;
      await this.login();

      const retryHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Cookie: this.getCookieHeader(),
      };
      if (method !== "GET" && method !== "HEAD" && this.csrfToken) {
        retryHeaders["X-CSRFToken"] = this.csrfToken;
      }

      const retryResponse = await fetch(url, {
        ...options,
        headers: { ...retryHeaders, ...((options?.headers as Record<string, string>) || {}) },
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
      console.error("RomM connection test failed:", error);
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
    await this.login();

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.disconnect();
        // Scan was emitted, just resolve even if we didn't get confirmation
        console.log(`[RomM] Scan emit timed out waiting for response, scan likely started`);
        resolve();
      }, 10_000);

      const socket = io(this.baseUrl, {
        path: "/ws/socket.io/",
        transports: ["polling", "websocket"],
        extraHeaders: {
          Cookie: this.getCookieHeader(),
        },
        withCredentials: true,
        timeout: 10_000,
      });

      socket.on("connect", () => {
        console.log(`[RomM] Socket connected, emitting scan event (type=${scanType}, platforms=${platformIds.join(",")||"all"})`);
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
          console.log(`[RomM] Scan triggered successfully`);
          resolve();
        }, 2000);
      });

      socket.on("scan:done", () => {
        clearTimeout(timeout);
        socket.disconnect();
        console.log(`[RomM] Scan completed`);
        resolve();
      });

      socket.on("connect_error", (err) => {
        clearTimeout(timeout);
        socket.disconnect();
        console.error(`[RomM] Socket connection error:`, err.message);
        reject(new Error(`RomM socket connection failed: ${err.message}`));
      });
    });
  }

  /** Trigger a scan of a specific platform in RomM. */
  async scanPlatform(platformId: number): Promise<void> {
    try {
      await this.triggerScan([platformId], "quick");
    } catch (e) {
      console.error(`[RomM] Platform scan failed:`, e instanceof Error ? e.message : e);
    }
  }

  /** Trigger a full library scan in RomM. */
  async scanAll(): Promise<void> {
    try {
      await this.triggerScan([], "quick");
    } catch (e) {
      console.error(`[RomM] Full scan failed:`, e instanceof Error ? e.message : e);
    }
  }
}

export async function getRomMClient(): Promise<RomMClient | null> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.rommUrl) return null;
  return new RomMClient(settings.rommUrl, settings.rommUsername, settings.rommPassword);
}
