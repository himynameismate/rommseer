/**
 * Feature 3.9 — Bulk Actions (Approve / Decline)
 * Tests: PATCH /api/requests/[id] for admin approve/decline,
 *        user self-cancel, and invalid transitions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import {
  adminSession, userSession, noSession,
  buildReq, seedUser, seedPlatform, seedGame, seedSettings, cleanupTestUsers,
} from "./helpers";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  notify: vi.fn(),
  logActivity: vi.fn(),
  sendDiscordWebhook: vi.fn(),
}));
vi.mock("@/lib/autograb", () => ({
  autoGrabForRequest: vi.fn().mockResolvedValue({ success: false, message: "mocked" }),
}));
vi.mock("@/lib/sync", () => ({
  syncAndRetryDownloads: vi.fn(),
  startBackgroundSync: vi.fn(),
}));

import { getServerSession } from "next-auth";

function mockSession(session: typeof adminSession | ReturnType<typeof userSession> | null) {
  vi.mocked(getServerSession).mockResolvedValue(session as never);
}

let platformId: number;
let gameId: number;
let game2Id: number;
let reqUser: { id: string };

async function createRequest(userId: string, gId: number, status = "PENDING") {
  return prisma.request.create({
    data: { userId, gameId: gId, status },
  });
}

async function cleanupRequests() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: "@test.local" } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (!userIds.length) return;
  const reqs = await prisma.request.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const ids = reqs.map((r) => r.id);
  if (ids.length) {
    await prisma.download.deleteMany({ where: { requestId: { in: ids } } });
    await prisma.activity.deleteMany({ where: { requestId: { in: ids } } });
    await prisma.request.deleteMany({ where: { id: { in: ids } } });
  }
}

beforeEach(async () => {
  const platform = await seedPlatform("bulk-test-platform");
  platformId = platform.id;
  const game = await prisma.game.upsert({ where: { igdbId: 888001 }, create: { igdbId: 888001, name: "Bulk Game 1", platformId }, update: {} });
  const game2 = await prisma.game.upsert({ where: { igdbId: 888002 }, create: { igdbId: 888002, name: "Bulk Game 2", platformId }, update: {} });
  gameId = game.id;
  game2Id = game2.id;

  reqUser = await seedUser("bulkuser@test.local");
  await seedSettings({});
});

afterEach(async () => {
  await cleanupRequests();
  await cleanupTestUsers();
  await prisma.game.deleteMany({ where: { igdbId: { in: [888001, 888002] } } });
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Feature 3.9 — Bulk Actions: Admin approve/decline", () => {
  it("TC-9.1: admin can approve a PENDING request", async () => {
    mockSession(adminSession);
    const req = await createRequest(reqUser.id, gameId);

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/${req.id}`, { method: "PATCH", body: { status: "APPROVED" } }),
      { params: { id: String(req.id) } }
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("APPROVED");

    const db = await prisma.request.findUnique({ where: { id: req.id } });
    expect(db!.status).toBe("APPROVED");
  });

  it("TC-9.2: admin can decline a PENDING request", async () => {
    mockSession(adminSession);
    const req = await createRequest(reqUser.id, gameId);

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/${req.id}`, { method: "PATCH", body: { status: "DECLINED" } }),
      { params: { id: String(req.id) } }
    );
    expect(res.status).toBe(200);

    const db = await prisma.request.findUnique({ where: { id: req.id } });
    expect(db!.status).toBe("DECLINED");
  });

  it("TC-9.2: admin can decline with an adminNote", async () => {
    mockSession(adminSession);
    const req = await createRequest(reqUser.id, gameId);

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/${req.id}`, { method: "PATCH", body: { status: "DECLINED", adminNote: "Not in scope" } }),
      { params: { id: String(req.id) } }
    );
    expect(res.status).toBe(200);

    const db = await prisma.request.findUnique({ where: { id: req.id } });
    expect(db!.status).toBe("DECLINED");
    expect(db!.adminNote).toBe("Not in scope");
  });

  it("admin can approve multiple requests independently", async () => {
    mockSession(adminSession);
    const req1 = await createRequest(reqUser.id, gameId);
    const req2 = await createRequest(reqUser.id, game2Id);

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const [res1, res2] = await Promise.all([
      PATCH(buildReq(`/api/requests/${req1.id}`, { method: "PATCH", body: { status: "APPROVED" } }), { params: { id: String(req1.id) } }),
      PATCH(buildReq(`/api/requests/${req2.id}`, { method: "PATCH", body: { status: "DECLINED" } }), { params: { id: String(req2.id) } }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const [db1, db2] = await Promise.all([
      prisma.request.findUnique({ where: { id: req1.id } }),
      prisma.request.findUnique({ where: { id: req2.id } }),
    ]);
    expect(db1!.status).toBe("APPROVED");
    expect(db2!.status).toBe("DECLINED");
  });

  it("TC-9.3: invalid status value is rejected with 400", async () => {
    mockSession(adminSession);
    const req = await createRequest(reqUser.id, gameId);

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/${req.id}`, { method: "PATCH", body: { status: "SUPERSTATE" } }),
      { params: { id: String(req.id) } }
    );
    expect(res.status).toBe(400);
  });

  it("approving an already-AVAILABLE request is rejected with 400", async () => {
    mockSession(adminSession);
    const req = await createRequest(reqUser.id, gameId, "AVAILABLE");

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/${req.id}`, { method: "PATCH", body: { status: "APPROVED" } }),
      { params: { id: String(req.id) } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/already available/i);
  });

  it("patching a non-existent request returns 404", async () => {
    mockSession(adminSession);
    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/999999`, { method: "PATCH", body: { status: "APPROVED" } }),
      { params: { id: "999999" } }
    );
    expect(res.status).toBe(404);
  });

  it("non-admin cannot approve requests", async () => {
    mockSession(userSession(reqUser.id, "bulkuser@test.local"));
    const req = await createRequest(reqUser.id, gameId);

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/${req.id}`, { method: "PATCH", body: { status: "APPROVED" } }),
      { params: { id: String(req.id) } }
    );
    expect(res.status).toBe(401);
  });

  it("unauthenticated request returns 401", async () => {
    mockSession(noSession);
    const req = await createRequest(reqUser.id, gameId);

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/${req.id}`, { method: "PATCH", body: { status: "APPROVED" } }),
      { params: { id: String(req.id) } }
    );
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Feature 3.9 — Bulk Actions: User self-cancel", () => {
  it("user can cancel their own PENDING request", async () => {
    mockSession(userSession(reqUser.id, "bulkuser@test.local"));
    const req = await createRequest(reqUser.id, gameId);

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/${req.id}`, { method: "PATCH", body: { status: "CANCELLED" } }),
      { params: { id: String(req.id) } }
    );
    expect(res.status).toBe(200);

    const db = await prisma.request.findUnique({ where: { id: req.id } });
    expect(db!.status).toBe("CANCELLED");
  });

  it("user cannot cancel another user's request", async () => {
    const otherUser = await seedUser("other-bulk@test.local");
    const req = await createRequest(otherUser.id, gameId);
    mockSession(userSession(reqUser.id, "bulkuser@test.local"));

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/${req.id}`, { method: "PATCH", body: { status: "CANCELLED" } }),
      { params: { id: String(req.id) } }
    );
    expect(res.status).toBe(403);
  });

  it("user cannot cancel a non-PENDING request", async () => {
    mockSession(userSession(reqUser.id, "bulkuser@test.local"));
    const req = await createRequest(reqUser.id, gameId, "APPROVED");

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/${req.id}`, { method: "PATCH", body: { status: "CANCELLED" } }),
      { params: { id: String(req.id) } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/only pending/i);
  });

  it("user cannot decline (only admin actions) — returns 401", async () => {
    mockSession(userSession(reqUser.id, "bulkuser@test.local"));
    const req = await createRequest(reqUser.id, gameId);

    const { PATCH } = await import("@/app/api/requests/[id]/route");
    const res = await PATCH(
      buildReq(`/api/requests/${req.id}`, { method: "PATCH", body: { status: "DECLINED" } }),
      { params: { id: String(req.id) } }
    );
    expect(res.status).toBe(401);
  });
});
