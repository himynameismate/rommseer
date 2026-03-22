import { prisma } from "@/lib/db";

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

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.username = username;
    this.password = password;
  }

  private async login(): Promise<void> {
    if (this.sessionCookie) return;

    // RomM uses HTTP Basic Authentication for /api/login
    const basicAuth = Buffer.from(`${this.username}:${this.password}`).toString("base64");

    const response = await fetch(`${this.baseUrl}/api/login`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuth}`,
      },
      redirect: "manual",
    });

    // Extract session cookie from response headers
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      // Parse the cookie name=value part
      const cookiePart = setCookie.split(";")[0];
      this.sessionCookie = cookiePart;
    }

    if (!this.sessionCookie) {
      // If no cookie, check if we got a redirect (302) which is common for successful login
      if (response.status === 302 || response.status === 301) {
        // Try to get cookie from redirect response
        const allHeaders = response.headers;
        const cookies: string[] = [];
        allHeaders.forEach((value, key) => {
          if (key.toLowerCase() === "set-cookie") {
            cookies.push(value.split(";")[0]);
          }
        });
        if (cookies.length > 0) {
          this.sessionCookie = cookies.join("; ");
        }
      }

      if (!this.sessionCookie) {
        throw new Error(
          `RomM login failed: ${response.status} ${response.statusText}`
        );
      }
    }
  }

  private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    // Ensure we're logged in
    await this.login();

    const url = `${this.baseUrl}/api${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.sessionCookie) {
      headers["Cookie"] = this.sessionCookie;
    }

    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });

    // If we got a 401/403, clear session and retry once
    if (response.status === 401 || response.status === 403) {
      this.sessionCookie = null;
      await this.login();

      const retryHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.sessionCookie) {
        retryHeaders["Cookie"] = this.sessionCookie;
      }

      const retryResponse = await fetch(url, {
        ...options,
        headers: { ...retryHeaders, ...options?.headers },
      });

      if (!retryResponse.ok) {
        throw new Error(
          `RomM API error: ${retryResponse.status} ${retryResponse.statusText}`
        );
      }

      return retryResponse.json();
    }

    if (!response.ok) {
      throw new Error(
        `RomM API error: ${response.status} ${response.statusText}`
      );
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

  async getRoms(
    platformId?: number,
    search?: string
  ): Promise<RomMRom[]> {
    const params = new URLSearchParams();
    if (platformId) params.set("platform_id", String(platformId));
    if (search) params.set("search_term", search);

    const query = params.toString();
    return this.fetch<RomMRom[]>(`/roms${query ? `?${query}` : ""}`);
  }

  async getRom(id: number): Promise<RomMRom> {
    return this.fetch<RomMRom>(`/roms/${id}`);
  }

  /** Trigger a scan of a specific platform in RomM. */
  async scanPlatform(platformId: number): Promise<void> {
    try {
      await this.fetch(`/platforms/${platformId}/roms/scan`, { method: "PUT" });
      console.log(`[RomM] Scan triggered for platform ${platformId}`);
    } catch (e) {
      // Some RomM versions use different scan endpoints, try alternatives
      try {
        await this.fetch(`/raw/scan`, { method: "PUT" });
        console.log(`[RomM] Full library scan triggered (fallback)`);
      } catch (e2) {
        console.error(`[RomM] Scan failed:`, e2 instanceof Error ? e2.message : e2);
      }
    }
  }

  /** Trigger a full library scan in RomM. */
  async scanAll(): Promise<void> {
    try {
      await this.fetch(`/platforms/scan`, { method: "PUT" });
      console.log(`[RomM] Full library scan triggered`);
    } catch (e) {
      console.error(`[RomM] Scan failed:`, e instanceof Error ? e.message : e);
    }
  }
}

export async function getRomMClient(): Promise<RomMClient | null> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.rommUrl) return null;
  return new RomMClient(settings.rommUrl, settings.rommUsername, settings.rommPassword);
}
