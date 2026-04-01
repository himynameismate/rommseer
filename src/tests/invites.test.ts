/**
 * Feature 3.3 — Invite Links
 * Tests: GET /api/invites, POST /api/invites
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import {
  adminSession, userSession, noSession,
  buildReq, seedUser, seedInvite, cleanupTestUsers, cleanupTestInvites,
} from "./helpers";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
import { getServerSession } from "next-auth";

function mockSession(session: typeof adminSession | ReturnType<typeof userSession> | null) {
  vi.mocked(getServerSession).mockResolvedValue(session as never);
}

let adminUser: { id: string };

beforeEach(async () => {
  adminUser = await seedUser("invite-admin@test.local", { role: "ADMIN" });
  // Override mock session to use the seeded admin's real ID so invites are created correctly
  vi.mocked(getServerSession).mockResolvedValue({
    ...adminSession,
    user: { ...adminSession.user, id: adminUser.id },
  } as never);
});

afterEach(async () => {
  await cleanupTestInvites(adminUser.id);
  await cleanupTestUsers();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Feature 3.3 — Invite Links: GET /api/invites", () => {
  it("admin can list invites", async () => {
    await seedInvite(adminUser.id);
    await seedInvite(adminUser.id);

    const { GET } = await import("@/app/api/invites/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(2);
    // Each invite includes createdBy
    expect(body[0]).toHaveProperty("createdBy");
    expect(body[0].createdBy).toHaveProperty("email");
  });

  it("non-admin cannot list invites", async () => {
    mockSession(userSession());
    const { GET } = await import("@/app/api/invites/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("unauthenticated request returns 401", async () => {
    mockSession(noSession);
    const { GET } = await import("@/app/api/invites/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Feature 3.3 — Invite Links: POST /api/invites", () => {
  it("TC-3.1: admin creates invite with default 48h expiry", async () => {
    const before = Date.now();
    const { POST } = await import("@/app/api/invites/route");
    const req = buildReq("/api/invites", { method: "POST", body: {} });
    const res = await POST(req);
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.token).toBeDefined();
    expect(body.email).toBeNull();

    const expiresMs = new Date(body.expiresAt).getTime();
    expect(expiresMs).toBeGreaterThan(before + 47 * 60 * 60 * 1000);
    expect(expiresMs).toBeLessThan(before + 49 * 60 * 60 * 1000);
  });

  it("custom expiresInHours is respected", async () => {
    const before = Date.now();
    const { POST } = await import("@/app/api/invites/route");
    const req = buildReq("/api/invites", { method: "POST", body: { expiresInHours: 24 } });
    const res = await POST(req);
    const body = await res.json();

    const expiresMs = new Date(body.expiresAt).getTime();
    expect(expiresMs).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
    expect(expiresMs).toBeLessThan(before + 25 * 60 * 60 * 1000);
  });

  it("expiresInHours is capped at 720 (30 days)", async () => {
    const before = Date.now();
    const { POST } = await import("@/app/api/invites/route");
    const req = buildReq("/api/invites", { method: "POST", body: { expiresInHours: 9999 } });
    const res = await POST(req);
    const body = await res.json();

    const expiresMs = new Date(body.expiresAt).getTime();
    const maxAllowed = before + 720 * 60 * 60 * 1000;
    expect(expiresMs).toBeLessThanOrEqual(maxAllowed + 5000);
  });

  it("invite can be restricted to a specific email", async () => {
    const { POST } = await import("@/app/api/invites/route");
    const req = buildReq("/api/invites", {
      method: "POST",
      body: { email: "specific@example.com" },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.email).toBe("specific@example.com");
  });

  it("invalid email format is rejected", async () => {
    const { POST } = await import("@/app/api/invites/route");
    const req = buildReq("/api/invites", { method: "POST", body: { email: "not-an-email" } });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid email/i);
  });

  it("negative expiresInHours falls back to default 48h", async () => {
    const before = Date.now();
    const { POST } = await import("@/app/api/invites/route");
    const req = buildReq("/api/invites", { method: "POST", body: { expiresInHours: -10 } });
    const res = await POST(req);
    const body = await res.json();

    const expiresMs = new Date(body.expiresAt).getTime();
    expect(expiresMs).toBeGreaterThan(before + 47 * 60 * 60 * 1000);
    expect(expiresMs).toBeLessThan(before + 49 * 60 * 60 * 1000);
  });

  it("invite token is a cuid string", async () => {
    const { POST } = await import("@/app/api/invites/route");
    const req = buildReq("/api/invites", { method: "POST", body: {} });
    const res = await POST(req);
    const body = await res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(10);
  });

  it("invite is saved in DB with createdById", async () => {
    const { POST } = await import("@/app/api/invites/route");
    const req = buildReq("/api/invites", { method: "POST", body: {} });
    const res = await POST(req);
    const body = await res.json();

    const dbInvite = await prisma.invite.findUnique({ where: { token: body.token } });
    expect(dbInvite).not.toBeNull();
    expect(dbInvite!.createdById).toBe(adminUser.id);
  });

  it("non-admin cannot create invites", async () => {
    mockSession(userSession());
    const { POST } = await import("@/app/api/invites/route");
    const req = buildReq("/api/invites", { method: "POST", body: {} });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("unauthenticated request returns 401", async () => {
    mockSession(noSession);
    const { POST } = await import("@/app/api/invites/route");
    const req = buildReq("/api/invites", { method: "POST", body: {} });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
