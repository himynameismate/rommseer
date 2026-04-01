import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });

  return NextResponse.json({
    registrationEnabled: settings?.registrationEnabled ?? false,
  });
}
