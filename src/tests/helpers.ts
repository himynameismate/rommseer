/**
 * Shared test helpers — session mocks, test data factories, request builders.
 */
import { vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

// ─── Session mock factories ───────────────────────────────────────────────────

export const adminSession = {
  user: { id: "test-admin-id", email: "admin@test.local", name: "Admin", role: "ADMIN" },
  expires: "2099-01-01T00:00:00.000Z",
};

export const userSession = (id = "test-user-id", email = "user@test.local") => ({
  user: { id, email, name: "Test User", role: "USER" },
  expires: "2099-01-01T00:00:00.000Z",
});

export const noSession = null;

// ─── Request builders ─────────────────────────────────────────────────────────

export function buildReq(
  url: string,
  options: { method?: string; body?: unknown } = {}
): NextRequest {
  const { method = "GET", body } = options;
  return new NextRequest(`http://localhost${url}`, {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }
      : {}),
  });
}

// ─── DB seed helpers ──────────────────────────────────────────────────────────

/** Create a test platform, reusing if slug already exists. */
export async function seedPlatform(slug = "test-platform") {
  return prisma.platform.upsert({
    where: { slug },
    create: { slug, name: "Test Platform" },
    update: {},
  });
}

/** Create a test game. */
export async function seedGame(platformId: number, igdbId = 888888) {
  return prisma.game.upsert({
    where: { igdbId },
    create: { igdbId, name: "Test Game", platformId },
    update: {},
  });
}

/** Create a test user with a unique email. */
export async function seedUser(
  email: string,
  overrides: {
    role?: string;
    isApproved?: boolean;
    requestQuota?: number;
    requestQuotaDays?: number;
    name?: string;
  } = {}
) {
  return prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: overrides.name ?? "Test User",
      hashedPassword: "hashed_dummy",
      role: overrides.role ?? "USER",
      isApproved: overrides.isApproved ?? true,
      requestQuota: overrides.requestQuota ?? 0,
      requestQuotaDays: overrides.requestQuotaDays ?? 7,
    },
    update: {},
  });
}

/** Create a test invite. */
export async function seedInvite(
  createdById: string,
  overrides: {
    email?: string;
    expiresAt?: Date;
    usedAt?: Date;
    usedBy?: string;
  } = {}
) {
  return prisma.invite.create({
    data: {
      createdById,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 48 * 60 * 60 * 1000),
      email: overrides.email ?? null,
      usedAt: overrides.usedAt ?? null,
      usedBy: overrides.usedBy ?? null,
    },
  });
}

/** Ensure a Settings row exists (needed for register/requests routes). */
export async function seedSettings(overrides: Record<string, unknown> = {}) {
  return prisma.settings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      registrationEnabled: false,
      prowlarrDryRun: false,
      prowlarrAutoGrab: false,
      ...overrides,
    },
    update: overrides,
  });
}

// ─── Cleanup helpers ──────────────────────────────────────────────────────────

/** Delete all test users whose email ends with @test.local */
export async function cleanupTestUsers() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: "@test.local" } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.invite.deleteMany({ where: { createdById: { in: ids } } });
  await prisma.activity.deleteMany({ where: { userId: { in: ids } } });
  const requestIds = (
    await prisma.request.findMany({ where: { userId: { in: ids } }, select: { id: true } })
  ).map((r) => r.id);
  if (requestIds.length) {
    await prisma.download.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.activity.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.request.deleteMany({ where: { id: { in: requestIds } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

export async function cleanupTestInvites(createdById: string) {
  await prisma.invite.deleteMany({ where: { createdById } });
}

export async function cleanupTestNotifications(userId: string) {
  await prisma.notification.deleteMany({ where: { userId } });
}
