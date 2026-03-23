const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  // Ensure rommLibraryPath has a default on existing installs
  try {
    const existingSettings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (existingSettings) {
      if (!existingSettings.rommLibraryPath) {
        await prisma.settings.update({
          where: { id: 1 },
          data: { rommLibraryPath: "/romm/library" },
        });
        console.log("Set default RomM library path to /romm/library");
      } else {
        console.log("RomM library path already set: " + existingSettings.rommLibraryPath);
      }
    }
  } catch (e) {
    console.log("Could not check/set library path (column may not exist yet):", e.message);
  }

  // Only seed if no admin user exists yet
  const existingAdmin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  if (existingAdmin) {
    console.log("Admin user already exists, skipping seed.");
    return;
  }

  const hashedPassword = await bcrypt.hash("admin", 12);

  await prisma.user.upsert({
    where: { email: "admin@rommseer.local" },
    update: {},
    create: {
      name: "Admin",
      email: "admin@rommseer.local",
      hashedPassword,
      role: "ADMIN",
    },
  });

  await prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      rommUrl: "",
      rommApiKey: "",
      igdbClientId: "",
      igdbClientSecret: "",
      rommLibraryPath: "/romm/library",
      initialized: false,
    },
  });

  console.log("Database seeded with default admin user (admin@rommseer.local / admin)");
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
