import { prisma } from "@/lib/db";

// Clean up test indexer records before/after each test
beforeEach(async () => {
  await prisma.indexerHealth.deleteMany({
    where: { indexer: { startsWith: "test-indexer" } },
  });
});

afterEach(async () => {
  await prisma.indexerHealth.deleteMany({
    where: { indexer: { startsWith: "test-indexer" } },
  });
});
