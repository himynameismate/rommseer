/**
 * Feature 3.8 — In-App Notifications
 * Tests: GET /api/notifications, PATCH /api/notifications
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import {
  adminSession, userSession, noSession,
  buildReq, seedUser, cleanupTestUsers, cleanupTestNotifications,
} from "./helpers";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
import { getServerSession } from "next-auth";

function mockSession(session: typeof adminSession | ReturnType<typeof userSession> | null) {
  vi.mocked(getServerSession).mockResolvedValue(session as never);
}

let notifUser: { id: string };

async function seedNotification(userId: string, overrides: { read?: boolean; type?: string; message?: string } = {}) {
  return prisma.notification.create({
    data: {
      userId,
      type: overrides.type ?? "REQUEST_CREATED",
      message: overrides.message ?? "Test notification",
      read: overrides.read ?? false,
    },
  });
}

beforeEach(async () => {
  notifUser = await seedUser("notif@test.local");
  mockSession(userSession(notifUser.id, "notif@test.local"));
});

afterEach(async () => {
  await cleanupTestNotifications(notifUser.id);
  await cleanupTestUsers();
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Feature 3.8 — Notifications: GET /api/notifications", () => {
  it("returns notifications and unreadCount for authenticated user", async () => {
    await seedNotification(notifUser.id, { read: false });
    await seedNotification(notifUser.id, { read: true });

    const { GET } = await import("@/app/api/notifications/route");
    const res = await GET(buildReq("/api/notifications"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.notifications)).toBe(true);
    expect(body.notifications.length).toBeGreaterThanOrEqual(2);
    expect(typeof body.unreadCount).toBe("number");
  });

  it("unreadCount only counts unread notifications", async () => {
    await seedNotification(notifUser.id, { read: false });
    await seedNotification(notifUser.id, { read: false });
    await seedNotification(notifUser.id, { read: true });

    const { GET } = await import("@/app/api/notifications/route");
    const res = await GET(buildReq("/api/notifications"));
    const body = await res.json();

    expect(body.unreadCount).toBe(2);
  });

  it("?unread=true returns only unread notifications", async () => {
    await seedNotification(notifUser.id, { read: false, message: "Unread one" });
    await seedNotification(notifUser.id, { read: true, message: "Read one" });

    const { GET } = await import("@/app/api/notifications/route");
    const res = await GET(buildReq("/api/notifications?unread=true"));
    const body = await res.json();

    expect(body.notifications.every((n: { read: boolean }) => !n.read)).toBe(true);
    expect(body.notifications.length).toBe(1);
    expect(body.notifications[0].message).toBe("Unread one");
  });

  it("returns empty list and unreadCount=0 when no notifications", async () => {
    const { GET } = await import("@/app/api/notifications/route");
    const res = await GET(buildReq("/api/notifications"));
    const body = await res.json();

    expect(body.notifications).toHaveLength(0);
    expect(body.unreadCount).toBe(0);
  });

  it("only returns the current user's notifications", async () => {
    const other = await seedUser("other-notif@test.local");
    await seedNotification(other.id, { message: "Other user's notification" });
    await seedNotification(notifUser.id, { message: "My notification" });

    const { GET } = await import("@/app/api/notifications/route");
    const res = await GET(buildReq("/api/notifications"));
    const body = await res.json();

    const messages = body.notifications.map((n: { message: string }) => n.message);
    expect(messages).toContain("My notification");
    expect(messages).not.toContain("Other user's notification");

    await cleanupTestNotifications(other.id);
  });

  it("unauthenticated request returns 401", async () => {
    mockSession(noSession);
    const { GET } = await import("@/app/api/notifications/route");
    const res = await GET(buildReq("/api/notifications"));
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Feature 3.8 — Notifications: PATCH /api/notifications", () => {
  it("TC-8.1: marking notifications as read returns success=true", async () => {
    const n1 = await seedNotification(notifUser.id, { read: false });
    const n2 = await seedNotification(notifUser.id, { read: false });

    const { PATCH } = await import("@/app/api/notifications/route");
    const req = buildReq("/api/notifications", { method: "PATCH", body: { ids: [n1.id, n2.id] } });
    const res = await PATCH(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("TC-8.1: notifications are marked read in DB", async () => {
    const n1 = await seedNotification(notifUser.id, { read: false });

    const { PATCH } = await import("@/app/api/notifications/route");
    await PATCH(buildReq("/api/notifications", { method: "PATCH", body: { ids: [n1.id] } }));

    const updated = await prisma.notification.findUnique({ where: { id: n1.id } });
    expect(updated!.read).toBe(true);
  });

  it("cannot mark another user's notifications as read", async () => {
    const other = await seedUser("other-notif2@test.local");
    const otherNotif = await seedNotification(other.id, { read: false });

    const { PATCH } = await import("@/app/api/notifications/route");
    await PATCH(buildReq("/api/notifications", { method: "PATCH", body: { ids: [otherNotif.id] } }));

    // The other user's notification should still be unread
    const stillUnread = await prisma.notification.findUnique({ where: { id: otherNotif.id } });
    expect(stillUnread!.read).toBe(false);

    await cleanupTestNotifications(other.id);
  });

  it("empty ids array returns 400", async () => {
    const { PATCH } = await import("@/app/api/notifications/route");
    const res = await PATCH(buildReq("/api/notifications", { method: "PATCH", body: { ids: [] } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-empty array/i);
  });

  it("non-array ids returns 400", async () => {
    const { PATCH } = await import("@/app/api/notifications/route");
    const res = await PATCH(buildReq("/api/notifications", { method: "PATCH", body: { ids: "not-an-array" } }));
    expect(res.status).toBe(400);
  });

  it("ids with non-numbers returns 400", async () => {
    const { PATCH } = await import("@/app/api/notifications/route");
    const res = await PATCH(buildReq("/api/notifications", { method: "PATCH", body: { ids: ["abc", "def"] } }));
    expect(res.status).toBe(400);
  });

  it("ids array exceeding 200 items returns 400", async () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => i + 1);
    const { PATCH } = await import("@/app/api/notifications/route");
    const res = await PATCH(buildReq("/api/notifications", { method: "PATCH", body: { ids: tooMany } }));
    expect(res.status).toBe(400);
  });

  it("unauthenticated request returns 401", async () => {
    mockSession(noSession);
    const { PATCH } = await import("@/app/api/notifications/route");
    const res = await PATCH(buildReq("/api/notifications", { method: "PATCH", body: { ids: [1] } }));
    expect(res.status).toBe(401);
  });
});
