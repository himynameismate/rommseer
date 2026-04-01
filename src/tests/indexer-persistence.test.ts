/**
 * TC-6.1 / TC-6.2 — Feature 3.6: Indexer Failure Persistence
 *
 * Tests that indexer health state is stored in the DB (not memory) and
 * that the block/cooldown/unblock lifecycle works correctly.
 */

import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import {
  recordIndexerFailure,
  recordIndexerSuccess,
  isIndexerBlocked,
} from "@/lib/autograb";

const INDEXER = "test-indexer-nyaa";
const THRESHOLD = 3; // must match INDEXER_FAIL_THRESHOLD in autograb.ts

describe("Feature 3.6 — Indexer Failure Persistence", () => {
  // ─────────────────────────────────────────────
  // Failure recording
  // ─────────────────────────────────────────────

  it("TC-6.1a: first failure creates a DB record with failureCount=1", async () => {
    await recordIndexerFailure(INDEXER);

    const record = await prisma.indexerHealth.findUnique({ where: { indexer: INDEXER } });
    expect(record).not.toBeNull();
    expect(record!.failureCount).toBe(1);
    expect(record!.lastFailure).not.toBeNull();
  });

  it("TC-6.1b: subsequent failures increment failureCount", async () => {
    await recordIndexerFailure(INDEXER);
    await recordIndexerFailure(INDEXER);

    const record = await prisma.indexerHealth.findUnique({ where: { indexer: INDEXER } });
    expect(record!.failureCount).toBe(2);
  });

  it("TC-6.1c: reaching threshold sets blockedUntil ~30 minutes in the future", async () => {
    const before = Date.now();
    await recordIndexerFailure(INDEXER);
    await recordIndexerFailure(INDEXER);
    await recordIndexerFailure(INDEXER); // 3rd failure = threshold

    const record = await prisma.indexerHealth.findUnique({ where: { indexer: INDEXER } });
    expect(record!.blockedUntil).not.toBeNull();

    const blockedUntilMs = record!.blockedUntil!.getTime();
    const expectedMin = before + 29 * 60 * 1000;
    const expectedMax = before + 31 * 60 * 1000;
    expect(blockedUntilMs).toBeGreaterThanOrEqual(expectedMin);
    expect(blockedUntilMs).toBeLessThanOrEqual(expectedMax);
  });

  it("TC-6.1d: blockedUntil is NOT reset by additional failures once already blocked", async () => {
    // Hit threshold
    await recordIndexerFailure(INDEXER);
    await recordIndexerFailure(INDEXER);
    await recordIndexerFailure(INDEXER);

    const afterThreshold = await prisma.indexerHealth.findUnique({ where: { indexer: INDEXER } });
    const originalBlockedUntil = afterThreshold!.blockedUntil!.getTime();

    // One more failure — should not change blockedUntil
    await recordIndexerFailure(INDEXER);

    const afterExtra = await prisma.indexerHealth.findUnique({ where: { indexer: INDEXER } });
    expect(afterExtra!.blockedUntil!.getTime()).toBe(originalBlockedUntil);
  });

  // ─────────────────────────────────────────────
  // isIndexerBlocked
  // ─────────────────────────────────────────────

  it("TC-6.1e: indexer with 0 failures is not blocked", async () => {
    const blocked = await isIndexerBlocked(INDEXER);
    expect(blocked).toBe(false);
  });

  it("TC-6.1f: indexer below threshold is not blocked", async () => {
    await recordIndexerFailure(INDEXER);
    await recordIndexerFailure(INDEXER);

    const blocked = await isIndexerBlocked(INDEXER);
    expect(blocked).toBe(false);
  });

  it("TC-6.1g: indexer at threshold with future blockedUntil IS blocked", async () => {
    await recordIndexerFailure(INDEXER);
    await recordIndexerFailure(INDEXER);
    await recordIndexerFailure(INDEXER);

    const blocked = await isIndexerBlocked(INDEXER);
    expect(blocked).toBe(true);
  });

  it("TC-6.2: indexer with expired blockedUntil is unblocked and record is deleted", async () => {
    // Manually create a record with an already-expired blockedUntil
    await prisma.indexerHealth.upsert({
      where: { indexer: INDEXER },
      create: {
        indexer: INDEXER,
        failureCount: THRESHOLD,
        lastFailure: new Date(Date.now() - 31 * 60 * 1000),
        blockedUntil: new Date(Date.now() - 1 * 60 * 1000), // 1 min ago
      },
      update: {
        failureCount: THRESHOLD,
        blockedUntil: new Date(Date.now() - 1 * 60 * 1000),
      },
    });

    const blocked = await isIndexerBlocked(INDEXER);
    expect(blocked).toBe(false);

    // Record should be cleaned up
    const record = await prisma.indexerHealth.findUnique({ where: { indexer: INDEXER } });
    expect(record).toBeNull();
  });

  // ─────────────────────────────────────────────
  // Success recording (reset)
  // ─────────────────────────────────────────────

  it("TC-6.1h: recordIndexerSuccess removes the DB record entirely", async () => {
    await recordIndexerFailure(INDEXER);
    await recordIndexerFailure(INDEXER);

    let record = await prisma.indexerHealth.findUnique({ where: { indexer: INDEXER } });
    expect(record).not.toBeNull();

    await recordIndexerSuccess(INDEXER);

    record = await prisma.indexerHealth.findUnique({ where: { indexer: INDEXER } });
    expect(record).toBeNull();
  });

  it("TC-6.1i: recordIndexerSuccess on a non-existent indexer does not throw", async () => {
    await expect(recordIndexerSuccess("test-indexer-nonexistent")).resolves.not.toThrow();
  });

  // ─────────────────────────────────────────────
  // DB persistence (simulates restart)
  // ─────────────────────────────────────────────

  it("TC-6.1j: failure state persists across function re-imports (DB-backed, not in-memory)", async () => {
    // Record 3 failures
    await recordIndexerFailure(INDEXER);
    await recordIndexerFailure(INDEXER);
    await recordIndexerFailure(INDEXER);

    // Re-import would reset in-memory state but DB persists — simulate by
    // directly reading DB as a fresh consumer would
    const freshRecord = await prisma.indexerHealth.findUnique({ where: { indexer: INDEXER } });
    expect(freshRecord!.failureCount).toBeGreaterThanOrEqual(THRESHOLD);
    expect(freshRecord!.blockedUntil).not.toBeNull();
    expect(freshRecord!.blockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });
});
