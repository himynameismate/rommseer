/**
 * TC-10.1 / TC-10.2 / TC-10.3 — Feature 3.10: Auto-Grab Dry-Run Mode
 *
 * Tests that dry-run mode short-circuits before any download is created,
 * returns the correct result shape, and that disabling it allows real grabs.
 *
 * Prowlarr, qBittorrent, and SABnzbd clients are mocked so no real network
 * calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";

// ─── Shared mock release data ─────────────────────────────────────────────────

const MOCK_RELEASES = [
  {
    guid: "guid-1",
    title: "Super Mario World (SNES) ROM",
    size: 512_000,
    seeders: 42,
    leechers: 5,
    downloadUrl: "https://indexer.test/dl/1",
    magnetUrl: null,
    infoHash: "abc123",
    indexerId: 1,
    indexer: "test-indexer-nyaa",
    publishDate: new Date().toISOString(),
    protocol: "torrent",
    age: 30,
    grabs: 100,
  },
  {
    guid: "guid-2",
    title: "Super Mario World (SNES) [v1.1]",
    size: 600_000,
    seeders: 10,
    leechers: 2,
    downloadUrl: "https://indexer.test/dl/2",
    magnetUrl: null,
    infoHash: "def456",
    indexerId: 1,
    indexer: "test-indexer-nyaa",
    publishDate: new Date().toISOString(),
    protocol: "torrent",
    age: 60,
    grabs: 40,
  },
];

// ─── Mock the clients module ──────────────────────────────────────────────────

vi.mock("@/lib/clients", () => ({
  getCachedProwlarrClient: vi.fn(),
  getCachedQBittorrentClient: vi.fn(),
  getCachedSABnzbdClient: vi.fn(),
  debouncedScan: vi.fn(),
}));

import * as clients from "@/lib/clients";

// ─── Test DB helpers ──────────────────────────────────────────────────────────

let testPlatformId: number;
let testGameId: number;
let testUserId: string;

async function setupTestData() {
  // Platform
  const platform = await prisma.platform.upsert({
    where: { slug: "snes-test" },
    create: { name: "SNES Test", slug: "snes-test" },
    update: {},
  });
  testPlatformId = platform.id;

  // Game
  const game = await prisma.game.upsert({
    where: { igdbId: 999999 },
    create: {
      igdbId: 999999,
      name: "Super Mario World",
      platformId: platform.id,
    },
    update: {},
  });
  testGameId = game.id;

  // User
  const user = await prisma.user.upsert({
    where: { email: "dryrun-test@rommseer.test" },
    create: {
      email: "dryrun-test@rommseer.test",
      name: "DryRun Test",
      hashedPassword: "dummy",
      isApproved: true,
    },
    update: {},
  });
  testUserId = user.id;
}

async function createTestRequest() {
  return prisma.request.create({
    data: {
      userId: testUserId,
      gameId: testGameId,
      status: "APPROVED",
    },
  });
}

async function cleanupTestRequests() {
  await prisma.download.deleteMany({
    where: { request: { userId: testUserId } },
  });
  await prisma.request.deleteMany({ where: { userId: testUserId } });
}

async function setSettings(overrides: Record<string, unknown>) {
  const prowlarrDefaults = {
    prowlarrAutoGrab: true,
    prowlarrUrl: "http://prowlarr.test",
    prowlarrApiKey: "test-key",
    prowlarrDryRun: false,
  };
  await prisma.settings.upsert({
    where: { id: 1 },
    create: { id: 1, ...prowlarrDefaults, ...overrides },
    update: { ...prowlarrDefaults, ...overrides },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Feature 3.10 — Auto-Grab Dry-Run Mode", () => {
  beforeEach(async () => {
    await setupTestData();

    // Default: Prowlarr returns 2 results, qBit configured
    vi.mocked(clients.getCachedProwlarrClient).mockResolvedValue({
      searchForRom: vi.fn().mockResolvedValue(MOCK_RELEASES),
      downloadFile: vi.fn(),
      grabRelease: vi.fn(),
    } as never);

    vi.mocked(clients.getCachedQBittorrentClient).mockResolvedValue({
      addTorrentByUrl: vi.fn().mockResolvedValue(undefined),
      addTorrentByFile: vi.fn().mockResolvedValue(undefined),
      getTorrents: vi.fn().mockResolvedValue([
        { hash: "abc123", name: "Super Mario World (SNES) ROM", added_on: Math.floor(Date.now() / 1000) - 1 },
      ]),
      deleteTorrents: vi.fn(),
    } as never);

    vi.mocked(clients.getCachedSABnzbdClient).mockResolvedValue(null);
  });

  afterEach(async () => {
    await cleanupTestRequests();
    vi.clearAllMocks();
  });

  // ── TC-10.1: No download created in dry-run ─────────────────────────────────

  it("TC-10.1: dry-run does NOT create a Download record", async () => {
    await setSettings({ prowlarrDryRun: true });
    const request = await createTestRequest();

    const { autoGrabForRequest } = await import("@/lib/autograb");
    await autoGrabForRequest(request.id);

    const downloads = await prisma.download.findMany({ where: { requestId: request.id } });
    expect(downloads).toHaveLength(0);
  });

  it("TC-10.1: dry-run does NOT change request status to DOWNLOADING", async () => {
    await setSettings({ prowlarrDryRun: true });
    const request = await createTestRequest();

    const { autoGrabForRequest } = await import("@/lib/autograb");
    await autoGrabForRequest(request.id);

    const updated = await prisma.request.findUnique({ where: { id: request.id } });
    expect(updated!.status).toBe("APPROVED");
  });

  it("TC-10.1: dry-run does NOT call qBittorrent addTorrent", async () => {
    await setSettings({ prowlarrDryRun: true });
    const request = await createTestRequest();
    const mockQbit = await clients.getCachedQBittorrentClient();

    const { autoGrabForRequest } = await import("@/lib/autograb");
    await autoGrabForRequest(request.id);

    expect(mockQbit!.addTorrentByUrl).not.toHaveBeenCalled();
    expect(mockQbit!.addTorrentByFile).not.toHaveBeenCalled();
  });

  // ── TC-10.2: Correct result shape ──────────────────────────────────────────

  it("TC-10.2: dry-run returns success=true with [DRY RUN] message", async () => {
    await setSettings({ prowlarrDryRun: true });
    const request = await createTestRequest();

    const { autoGrabForRequest } = await import("@/lib/autograb");
    const result = await autoGrabForRequest(request.id);

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/^\[DRY RUN\]/);
    expect(result.message).toContain("Super Mario World (SNES) ROM");
    expect(result.message).toContain("test-indexer-nyaa");
  });

  it("TC-10.2: dry-run result includes torrentTitle and indexer fields", async () => {
    await setSettings({ prowlarrDryRun: true });
    const request = await createTestRequest();

    const { autoGrabForRequest } = await import("@/lib/autograb");
    const result = await autoGrabForRequest(request.id);

    expect(result.torrentTitle).toBe("Super Mario World (SNES) ROM");
    expect(result.indexer).toBe("test-indexer-nyaa");
  });

  it("TC-10.2: dry-run picks the first viable result (highest priority)", async () => {
    await setSettings({ prowlarrDryRun: true });
    const request = await createTestRequest();

    const { autoGrabForRequest } = await import("@/lib/autograb");
    const result = await autoGrabForRequest(request.id);

    // First result in MOCK_RELEASES should win
    expect(result.torrentTitle).toBe(MOCK_RELEASES[0].title);
  });

  it("TC-10.2: dry-run reports correct viable result count in message", async () => {
    await setSettings({ prowlarrDryRun: true });
    const request = await createTestRequest();

    const { autoGrabForRequest } = await import("@/lib/autograb");
    const result = await autoGrabForRequest(request.id);

    // 2 mock results, none blocked
    expect(result.message).toContain("2 viable results");
  });

  // ── TC-10.3: Disabling dry-run resumes real download ───────────────────────

  it("TC-10.3: with dry-run OFF, a Download record IS created", async () => {
    await setSettings({ prowlarrDryRun: false });
    const request = await createTestRequest();

    const { autoGrabForRequest } = await import("@/lib/autograb");
    const result = await autoGrabForRequest(request.id);

    expect(result.success).toBe(true);
    expect(result.message).not.toMatch(/^\[DRY RUN\]/);

    const downloads = await prisma.download.findMany({ where: { requestId: request.id } });
    expect(downloads).toHaveLength(1);
    expect(downloads[0].status).toBe("DOWNLOADING");
  });

  it("TC-10.3: with dry-run OFF, request status changes to DOWNLOADING", async () => {
    await setSettings({ prowlarrDryRun: false });
    const request = await createTestRequest();

    const { autoGrabForRequest } = await import("@/lib/autograb");
    await autoGrabForRequest(request.id);

    const updated = await prisma.request.findUnique({ where: { id: request.id } });
    expect(updated!.status).toBe("DOWNLOADING");
  });

  it("TC-10.3: with dry-run OFF, qBittorrent is called", async () => {
    await setSettings({ prowlarrDryRun: false });
    const request = await createTestRequest();
    const mockQbit = await clients.getCachedQBittorrentClient();

    const { autoGrabForRequest } = await import("@/lib/autograb");
    await autoGrabForRequest(request.id);

    // Either addTorrentByUrl or addTorrentByFile should be called
    const called =
      vi.mocked(mockQbit!.addTorrentByUrl).mock.calls.length > 0 ||
      vi.mocked(mockQbit!.addTorrentByFile).mock.calls.length > 0;
    expect(called).toBe(true);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it("TC-10.1: dry-run with no Prowlarr results returns success=false", async () => {
    await setSettings({ prowlarrDryRun: true });
    vi.mocked(clients.getCachedProwlarrClient).mockResolvedValue({
      searchForRom: vi.fn().mockResolvedValue([]),
      downloadFile: vi.fn(),
      grabRelease: vi.fn(),
    } as never);

    const request = await createTestRequest();
    const { autoGrabForRequest } = await import("@/lib/autograb");
    const result = await autoGrabForRequest(request.id);

    expect(result.success).toBe(false);
    expect(result.message).toContain("No results");
  });

  it("TC-10.1: dry-run when prowlarrAutoGrab is false returns immediately", async () => {
    await setSettings({ prowlarrDryRun: true, prowlarrAutoGrab: false });
    const request = await createTestRequest();

    const { autoGrabForRequest } = await import("@/lib/autograb");
    const result = await autoGrabForRequest(request.id);

    expect(result.success).toBe(false);
    expect(result.message).toBe("Auto-grab not enabled");
    expect(clients.getCachedProwlarrClient).not.toHaveBeenCalled();
  });
});
