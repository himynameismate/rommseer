/**
 * Feature 3.2 — Self-Registration with Admin Approval
 * Tests: POST /api/auth/register, GET /api/settings/public
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { buildReq, seedUser, seedSettings, seedInvite, cleanupTestUsers } from "./helpers";

// register route does not use getServerSession
// settings/public route does not use getServerSession

afterEach(cleanupTestUsers);

describe("Feature 3.2 — Self-Registration: POST /api/auth/register", () => {

  // ── Registration disabled ────────────────────────────────────────────────

  it("TC-2.5: blocked when registration disabled and no invite", async () => {
    await seedSettings({ registrationEnabled: false });
    const { POST } = await import("@/app/api/auth/register/route");
    const req = buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Alice", email: "alice@test.local", password: "password123" },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/registration is not enabled/i);
  });

  // ── Open registration ────────────────────────────────────────────────────

  it("TC-2.3: succeeds and creates unapproved user when registration enabled", async () => {
    await seedSettings({ registrationEnabled: true });
    const { POST } = await import("@/app/api/auth/register/route");
    const req = buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Bob", email: "bob@test.local", password: "password123" },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);

    const user = await prisma.user.findUnique({ where: { email: "bob@test.local" } });
    expect(user).not.toBeNull();
    expect(user!.isApproved).toBe(false);
    expect(user!.approvedAt).toBeNull();
  });

  it("TC-2.4: unapproved user has isApproved=false in DB (auth.ts will block login)", async () => {
    await seedSettings({ registrationEnabled: true });
    const { POST } = await import("@/app/api/auth/register/route");
    const req = buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Charlie", email: "charlie@test.local", password: "password123" },
    });
    await POST(req);

    const user = await prisma.user.findUnique({ where: { email: "charlie@test.local" } });
    expect(user!.isApproved).toBe(false);
  });

  // ── Input validation ─────────────────────────────────────────────────────

  it("TC-2.6: duplicate email returns 409", async () => {
    await seedSettings({ registrationEnabled: true });
    await seedUser("dupe@test.local");
    const { POST } = await import("@/app/api/auth/register/route");
    const req = buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Dupe", email: "dupe@test.local", password: "password123" },
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);
  });

  it("TC-2.8: password shorter than 6 characters is rejected", async () => {
    await seedSettings({ registrationEnabled: true });
    const { POST } = await import("@/app/api/auth/register/route");
    const req = buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Short", email: "short@test.local", password: "abc" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/6 characters/i);
  });

  it("TC-2.9: whitespace-only name is rejected", async () => {
    await seedSettings({ registrationEnabled: true });
    const { POST } = await import("@/app/api/auth/register/route");
    const req = buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "   ", email: "ws@test.local", password: "password123" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  it("invalid email format is rejected", async () => {
    await seedSettings({ registrationEnabled: true });
    const { POST } = await import("@/app/api/auth/register/route");
    const req = buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Bad Email", email: "not-an-email", password: "password123" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/email/i);
  });

  it("password is hashed (not stored in plaintext)", async () => {
    await seedSettings({ registrationEnabled: true });
    const { POST } = await import("@/app/api/auth/register/route");
    await POST(buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "HashCheck", email: "hashcheck@test.local", password: "mypassword" },
    }));

    const user = await prisma.user.findUnique({ where: { email: "hashcheck@test.local" } });
    expect(user!.hashedPassword).not.toBe("mypassword");
    expect(user!.hashedPassword).toMatch(/^\$2[aby]\$/); // bcrypt prefix
  });

  // ── Invite flow ─────────────────────────────────────────────────────────

  it("TC-3.2: valid invite auto-approves user even when registration is disabled", async () => {
    await seedSettings({ registrationEnabled: false });
    const creator = await seedUser("inviter@test.local", { role: "ADMIN" });
    const invite = await seedInvite(creator.id);

    const { POST } = await import("@/app/api/auth/register/route");
    const req = buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Invited", email: "invited@test.local", password: "password123", inviteToken: invite.token },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);

    const user = await prisma.user.findUnique({ where: { email: "invited@test.local" } });
    expect(user!.isApproved).toBe(true);
    expect(user!.approvedAt).not.toBeNull();
  });

  it("TC-3.2: invite is marked used after registration", async () => {
    await seedSettings({ registrationEnabled: false });
    const creator = await seedUser("inviter2@test.local", { role: "ADMIN" });
    const invite = await seedInvite(creator.id);

    const { POST } = await import("@/app/api/auth/register/route");
    await POST(buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Used", email: "used@test.local", password: "password123", inviteToken: invite.token },
    }));

    const updatedInvite = await prisma.invite.findUnique({ where: { token: invite.token } });
    expect(updatedInvite!.usedAt).not.toBeNull();
    expect(updatedInvite!.usedBy).not.toBeNull();
  });

  it("TC-3.3: expired invite is rejected", async () => {
    await seedSettings({ registrationEnabled: false });
    const creator = await seedUser("inviter3@test.local", { role: "ADMIN" });
    const invite = await seedInvite(creator.id, {
      expiresAt: new Date(Date.now() - 1000),
    });

    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Late", email: "late@test.local", password: "password123", inviteToken: invite.token },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/expired/i);
  });

  it("TC-3.4: already-used invite is rejected", async () => {
    await seedSettings({ registrationEnabled: false });
    const creator = await seedUser("inviter4@test.local", { role: "ADMIN" });
    const invite = await seedInvite(creator.id, { usedAt: new Date(), usedBy: "someone" });

    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Used", email: "usedtry@test.local", password: "password123", inviteToken: invite.token },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/already been used/i);
  });

  it("TC-3.5: email-restricted invite rejects wrong email", async () => {
    await seedSettings({ registrationEnabled: false });
    const creator = await seedUser("inviter5@test.local", { role: "ADMIN" });
    const invite = await seedInvite(creator.id, { email: "specific@example.com" });

    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Wrong", email: "wrong@test.local", password: "password123", inviteToken: invite.token },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/restricted/i);
  });

  it("TC-3.6: email-restricted invite accepts correct email", async () => {
    await seedSettings({ registrationEnabled: false });
    const creator = await seedUser("inviter6@test.local", { role: "ADMIN" });
    const invite = await seedInvite(creator.id, { email: "correct@test.local" });

    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Correct", email: "correct@test.local", password: "password123", inviteToken: invite.token },
    }));
    expect(res.status).toBe(201);
  });

  it("invalid invite token is rejected", async () => {
    await seedSettings({ registrationEnabled: false });
    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(buildReq("/api/auth/register", {
      method: "POST",
      body: { name: "Fake", email: "fake@test.local", password: "password123", inviteToken: "not-a-real-token" },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid invite/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Feature 3.2 — Self-Registration: GET /api/settings/public", () => {
  it("TC-2.1: returns registrationEnabled=false when disabled", async () => {
    await seedSettings({ registrationEnabled: false });
    const { GET } = await import("@/app/api/settings/public/route");
    const res = await GET();
    const body = await res.json();
    expect(body.registrationEnabled).toBe(false);
  });

  it("TC-2.2: returns registrationEnabled=true when enabled", async () => {
    await seedSettings({ registrationEnabled: true });
    const { GET } = await import("@/app/api/settings/public/route");
    const res = await GET();
    const body = await res.json();
    expect(body.registrationEnabled).toBe(true);
  });

  it("returns 200 with no auth required", async () => {
    await seedSettings({ registrationEnabled: false });
    const { GET } = await import("@/app/api/settings/public/route");
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
