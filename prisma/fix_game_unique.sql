PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS "Game_new";

CREATE TABLE "Game_new" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "igdbId" INTEGER,
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "coverUrl" TEXT,
    "releaseDate" TEXT,
    "rating" REAL,
    "platformId" INTEGER NOT NULL,
    "rommId" INTEGER,
    "isAvailable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Game_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "Platform" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "Game_new" SELECT * FROM "Game";
DROP TABLE "Game";
ALTER TABLE "Game_new" RENAME TO "Game";

CREATE UNIQUE INDEX "Game_igdbId_platformId_key" ON "Game"("igdbId", "platformId");
CREATE INDEX "Game_platformId_idx" ON "Game"("platformId");
CREATE INDEX "Game_name_idx" ON "Game"("name");

PRAGMA foreign_keys = ON;
