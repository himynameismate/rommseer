import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { syncRomMLibrary } from "@/lib/sync";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await syncRomMLibrary();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Manual library sync error:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
