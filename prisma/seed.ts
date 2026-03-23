import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
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

  // Seed some common platforms
  const platforms = [
    { slug: "nes", name: "Nintendo Entertainment System" },
    { slug: "snes", name: "Super Nintendo" },
    { slug: "n64", name: "Nintendo 64" },
    { slug: "gb", name: "Game Boy" },
    { slug: "gba", name: "Game Boy Advance" },
    { slug: "gbc", name: "Game Boy Color" },
    { slug: "nds", name: "Nintendo DS" },
    { slug: "gamecube", name: "GameCube" },
    { slug: "wii", name: "Wii" },
    { slug: "genesis", name: "Sega Genesis" },
    { slug: "dreamcast", name: "Dreamcast" },
    { slug: "psx", name: "PlayStation" },
    { slug: "ps2", name: "PlayStation 2" },
    { slug: "psp", name: "PlayStation Portable" },
    { slug: "arcade", name: "Arcade" },
    { slug: "atari2600", name: "Atari 2600" },
  ];

  for (const platform of platforms) {
    await prisma.platform.upsert({
      where: { slug: platform.slug },
      update: {},
      create: platform,
    });
  }

  console.log("Database seeded successfully!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
