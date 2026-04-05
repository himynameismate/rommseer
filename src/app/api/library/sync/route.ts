import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { syncRomMLibrary } from "@/lib/sync";
import { getCachedRomMClient } from "@/lib/clients";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // Trigger a RomM scan first so deleted/added files are reflected before we sync
    const romm = await getCachedRomMClient();
    if (romm) {
      try {
        await romm.scanAll();
      } catch {
        // Non-fatal — proceed with sync even if scan trigger fails
      }
    }

    await syncRomMLibrary();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Manual library sync error:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
