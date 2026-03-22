import { prisma } from "@/lib/db";

export interface SABnzbdSlot {
  nzo_id: string;
  filename: string;
  mb: string;
  mbleft: string;
  percentage: string;
  status: string;
  timeleft: string;
  cat: string;
}

export interface SABnzbdHistorySlot {
  nzo_id: string;
  name: string;
  bytes: number;
  status: string;
  category: string;
  completed: number;
  storage: string;
  fail_message: string;
}

export interface SABnzbdQueue {
  slots: SABnzbdSlot[];
  speed: string;
  sizeleft: string;
  timeleft: string;
  noofslots: number;
  status: string;
}

export interface SABnzbdHistory {
  slots: SABnzbdHistorySlot[];
  noofslots: number;
}

export class SABnzbdClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private async fetch<T>(params: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}/api`);
    url.searchParams.set("apikey", this.apiKey);
    url.searchParams.set("output", "json");
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(
        `SABnzbd API error: ${response.status} ${response.statusText}`
      );
    }

    return response.json();
  }

  async testConnection(): Promise<boolean> {
    try {
      const result = await this.fetch<{ version: string }>({
        mode: "version",
      });
      return !!result.version;
    } catch (error) {
      console.error("SABnzbd connection test failed:", error);
      return false;
    }
  }

  async getVersion(): Promise<string> {
    const result = await this.fetch<{ version: string }>({
      mode: "version",
    });
    return result.version;
  }

  async getQueue(): Promise<SABnzbdQueue> {
    const result = await this.fetch<{ queue: SABnzbdQueue }>({
      mode: "queue",
    });
    return result.queue;
  }

  async getHistory(limit = 50): Promise<SABnzbdHistory> {
    const result = await this.fetch<{ history: SABnzbdHistory }>({
      mode: "history",
      limit: String(limit),
    });
    return result.history;
  }

  /**
   * Add an NZB by URL (e.g. from an indexer/Prowlarr).
   * Returns the NZB ID(s) on success.
   */
  async addNzbByUrl(
    nzbUrl: string,
    options?: {
      category?: string;
      name?: string;
    }
  ): Promise<string[]> {
    const params: Record<string, string> = {
      mode: "addurl",
      name: nzbUrl,
    };

    if (options?.category) params.cat = options.category;
    if (options?.name) params.nzbname = options.name;

    const result = await this.fetch<{
      status: boolean;
      nzo_ids: string[];
      error?: string;
    }>(params);

    if (!result.status) {
      throw new Error(result.error || "Failed to add NZB to SABnzbd");
    }

    return result.nzo_ids;
  }

  /**
   * Add an NZB by file upload.
   * Returns the NZB ID(s) on success.
   */
  async addNzbByFile(
    nzbFile: Buffer,
    filename: string,
    options?: {
      category?: string;
      name?: string;
    }
  ): Promise<string[]> {
    const url = new URL(`${this.baseUrl}/api`);
    url.searchParams.set("apikey", this.apiKey);
    url.searchParams.set("output", "json");
    url.searchParams.set("mode", "addfile");

    if (options?.category) url.searchParams.set("cat", options.category);
    if (options?.name) url.searchParams.set("nzbname", options.name);

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(nzbFile)], { type: "application/x-nzb" });
    formData.append("nzbfile", blob, filename);

    const response = await fetch(url.toString(), {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(
        `SABnzbd upload error: ${response.status} ${response.statusText}`
      );
    }

    const result = await response.json();

    if (!result.status) {
      throw new Error(result.error || "Failed to upload NZB to SABnzbd");
    }

    return result.nzo_ids;
  }

  /**
   * Delete items from the queue or history.
   */
  async deleteItem(nzoId: string, deleteFiles = false): Promise<void> {
    // Try queue first
    await this.fetch({
      mode: "queue",
      name: "delete",
      value: nzoId,
      del_files: deleteFiles ? "1" : "0",
    });
  }

  /**
   * Pause a queue item.
   */
  async pauseItem(nzoId: string): Promise<void> {
    await this.fetch({
      mode: "queue",
      name: "pause",
      value: nzoId,
    });
  }

  /**
   * Resume a queue item.
   */
  async resumeItem(nzoId: string): Promise<void> {
    await this.fetch({
      mode: "queue",
      name: "resume",
      value: nzoId,
    });
  }

  async getCategories(): Promise<string[]> {
    const result = await this.fetch<{ categories: string[] }>({
      mode: "get_cats",
    });
    return result.categories;
  }
}

export async function getSABnzbdClient(): Promise<SABnzbdClient | null> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.sabnzbdUrl || !settings?.sabnzbdApiKey) return null;
  return new SABnzbdClient(settings.sabnzbdUrl, settings.sabnzbdApiKey);
}
