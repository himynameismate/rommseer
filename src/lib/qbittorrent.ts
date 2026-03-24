import { prisma } from "@/lib/db";

export interface QBitTorrent {
  hash: string;
  name: string;
  size: number;
  progress: number;
  dlspeed: number;
  upspeed: number;
  num_seeds: number;
  num_leechs: number;
  state: string;
  category: string;
  tags: string;
  added_on: number;
  completion_on: number;
  save_path: string;
  content_path: string;
}

export interface QBitTransferInfo {
  dl_info_speed: number;
  dl_info_data: number;
  up_info_speed: number;
  up_info_data: number;
  dl_rate_limit: number;
  up_rate_limit: number;
  connection_status: string;
}

export class QBittorrentClient {
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

    const response = await fetch(`${this.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        username: this.username,
        password: this.password,
      }).toString(),
      redirect: "manual",
    });

    const responseText = await response.text();

    // qBittorrent returns "Ok." on successful login
    if (responseText !== "Ok.") {
      throw new Error(
        `qBittorrent login failed: ${response.status} - ${responseText}`
      );
    }

    // Extract SID cookie
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const cookiePart = setCookie.split(";")[0];
      this.sessionCookie = cookiePart;
    }

    if (!this.sessionCookie) {
      throw new Error("qBittorrent login succeeded but no session cookie received");
    }
  }

  private async fetch<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> {
    await this.login();

    const url = `${this.baseUrl}/api/v2${endpoint}`;
    const headers: Record<string, string> = {};

    if (this.sessionCookie) {
      headers["Cookie"] = this.sessionCookie;
    }

    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });

    // If auth expired, retry once
    if (response.status === 403) {
      this.sessionCookie = null;
      await this.login();

      const retryHeaders: Record<string, string> = {};
      if (this.sessionCookie) {
        retryHeaders["Cookie"] = this.sessionCookie;
      }

      const retryResponse = await fetch(url, {
        ...options,
        headers: { ...retryHeaders, ...options?.headers },
      });

      if (!retryResponse.ok) {
        throw new Error(
          `qBittorrent API error: ${retryResponse.status} ${retryResponse.statusText}`
        );
      }

      const text = await retryResponse.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text);
      } catch {
        return text as T;
      }
    }

    if (!response.ok) {
      throw new Error(
        `qBittorrent API error: ${response.status} ${response.statusText}`
      );
    }

    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text);
    } catch {
      // Some endpoints return plain text (e.g. /app/version returns "v5.1.4")
      return text as T;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.login();
      return true;
    } catch (error) {
      console.error("qBittorrent connection test failed:", error);
      return false;
    }
  }

  async getVersion(): Promise<string> {
    return this.fetch<string>("/app/version");
  }

  async getTransferInfo(): Promise<QBitTransferInfo> {
    return this.fetch<QBitTransferInfo>("/transfer/info");
  }

  async getTorrents(
    filter?: string,
    category?: string
  ): Promise<QBitTorrent[]> {
    const params = new URLSearchParams();
    if (filter) params.set("filter", filter);
    if (category) params.set("category", category);
    const query = params.toString();
    return this.fetch<QBitTorrent[]>(`/torrents/info${query ? `?${query}` : ""}`);
  }

  async addTorrentByUrl(
    torrentUrl: string,
    options?: {
      savepath?: string;
      category?: string;
      tags?: string;
      paused?: boolean;
    }
  ): Promise<void> {
    await this.login();

    const formData = new URLSearchParams();
    formData.set("urls", torrentUrl);
    if (options?.savepath) formData.set("savepath", options.savepath);
    if (options?.category) formData.set("category", options.category);
    if (options?.tags) formData.set("tags", options.tags);
    if (options?.paused !== undefined)
      formData.set("paused", options.paused ? "true" : "false");

    const url = `${this.baseUrl}/api/v2/torrents/add`;
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (this.sessionCookie) {
      headers["Cookie"] = this.sessionCookie;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: formData.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to add torrent: ${response.status} ${response.statusText}`
      );
    }

    // qBittorrent returns "Ok." for success and "Fails." for failure (both 200)
    const text = await response.text();
    if (text.trim().toLowerCase().startsWith("fail")) {
      throw new Error(`qBittorrent rejected torrent: ${text.trim()}`);
    }
  }

  async addTorrentByFile(
    torrentFile: Buffer,
    filename: string,
    options?: {
      savepath?: string;
      category?: string;
      tags?: string;
      paused?: boolean;
    }
  ): Promise<void> {
    await this.login();

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(torrentFile)], { type: "application/x-bittorrent" });
    formData.append("torrents", blob, filename);
    if (options?.savepath) formData.append("savepath", options.savepath);
    if (options?.category) formData.append("category", options.category);
    if (options?.tags) formData.append("tags", options.tags);
    if (options?.paused !== undefined)
      formData.append("paused", options.paused ? "true" : "false");

    const url = `${this.baseUrl}/api/v2/torrents/add`;
    const headers: Record<string, string> = {};
    if (this.sessionCookie) {
      headers["Cookie"] = this.sessionCookie;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: formData,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to add torrent file: ${response.status} ${response.statusText}`
      );
    }

    const text = await response.text();
    if (text.trim().toLowerCase().startsWith("fail")) {
      throw new Error(`qBittorrent rejected torrent file: ${text.trim()}`);
    }
  }

  async deleteTorrents(
    hashes: string[],
    deleteFiles = false
  ): Promise<void> {
    await this.login();

    const url = `${this.baseUrl}/api/v2/torrents/delete`;
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (this.sessionCookie) {
      headers["Cookie"] = this.sessionCookie;
    }

    const formData = new URLSearchParams();
    formData.set("hashes", hashes.join("|"));
    formData.set("deleteFiles", deleteFiles ? "true" : "false");

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: formData.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to delete torrents: ${response.status} ${response.statusText}`
      );
    }
  }

  async pauseTorrents(hashes: string[]): Promise<void> {
    await this.fetch("/torrents/pause", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ hashes: hashes.join("|") }).toString(),
    });
  }

  async resumeTorrents(hashes: string[]): Promise<void> {
    await this.fetch("/torrents/resume", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ hashes: hashes.join("|") }).toString(),
    });
  }

  async getCategories(): Promise<Record<string, { name: string; savePath: string }>> {
    return this.fetch("/torrents/categories");
  }

  async createCategory(name: string, savePath?: string): Promise<void> {
    const params = new URLSearchParams({ category: name });
    if (savePath) params.set("savePath", savePath);

    await this.fetch("/torrents/createCategory", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  }
}

export async function getQBittorrentClient(): Promise<QBittorrentClient | null> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.qbitUrl || !settings?.qbitUsername || !settings?.qbitPassword) {
    return null;
  }
  return new QBittorrentClient(
    settings.qbitUrl,
    settings.qbitUsername,
    settings.qbitPassword
  );
}
