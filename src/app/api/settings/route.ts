import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { RomMClient } from "@/lib/romm";
import { QBittorrentClient } from "@/lib/qbittorrent";
import { ProwlarrClient } from "@/lib/prowlarr";
import { SABnzbdClient } from "@/lib/sabnzbd";
import { applyRateLimit } from "@/lib/rate-limit";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) {
    return NextResponse.json({
      rommUrl: "",
      rommUsername: "",
      rommPassword: "",
      igdbClientId: "",
      igdbClientSecret: "",
      qbitUrl: "",
      qbitUsername: "",
      qbitPassword: "",
      qbitCategory: "rommseer",
      qbitSavePath: "",
      prowlarrUrl: "",
      prowlarrApiKey: "",
      prowlarrAutoGrab: false,
      prowlarrSearchTemplate: "{game_name} {platform} ROM",
      prowlarrMinSeeders: 1,
      prowlarrMaxSizeMb: 0,
      prowlarrPreferredIndexers: "",
      sabnzbdUrl: "",
      sabnzbdApiKey: "",
      sabnzbdCategory: "rommseer",
      autoApprove: false,
      rommLibraryPath: "",
      initialized: false,
    });
  }

  return NextResponse.json({
    ...settings,
    rommPassword: settings.rommPassword ? "********" : "",
    igdbClientSecret: settings.igdbClientSecret ? "********" : "",
    qbitPassword: settings.qbitPassword ? "********" : "",
    prowlarrApiKey: settings.prowlarrApiKey ? "********" : "",
    sabnzbdApiKey: settings.sabnzbdApiKey ? "********" : "",
  });
}

export async function PUT(req: NextRequest) {
  const rateLimited = applyRateLimit(req, "settings-put", 20, 60_000);
  if (rateLimited) return rateLimited;

  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const {
    rommUrl,
    rommUsername,
    rommPassword,
    igdbClientId,
    igdbClientSecret,
    qbitUrl,
    qbitUsername,
    qbitPassword,
    qbitCategory,
    qbitSavePath,
    prowlarrUrl,
    prowlarrApiKey,
    prowlarrAutoGrab,
    prowlarrSearchTemplate,
    prowlarrMinSeeders,
    prowlarrMaxSizeMb,
    prowlarrPreferredIndexers,
    sabnzbdUrl,
    sabnzbdApiKey,
    sabnzbdCategory,
    autoApprove,
    rommLibraryPath,
  } = body;

  // Validate URL fields use http:// or https:// schemes only
  const urlFields: Record<string, unknown> = { rommUrl, prowlarrUrl, qbitUrl, sabnzbdUrl };
  for (const [fieldName, value] of Object.entries(urlFields)) {
    if (value !== undefined && value !== null && value !== "") {
      const urlStr = String(value);
      try {
        const parsed = new URL(urlStr);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return NextResponse.json(
            { error: `${fieldName} must use http:// or https://` },
            { status: 400 }
          );
        }
      } catch {
        return NextResponse.json(
          { error: `${fieldName} is not a valid URL` },
          { status: 400 }
        );
      }
    }
  }

  const data: Record<string, unknown> = { initialized: true };

  // RomM
  if (rommUrl !== undefined) data.rommUrl = rommUrl;
  if (rommUsername !== undefined) data.rommUsername = rommUsername;
  if (rommPassword && rommPassword !== "********") data.rommPassword = rommPassword;

  // IGDB
  if (igdbClientId !== undefined) data.igdbClientId = igdbClientId;
  if (igdbClientSecret && igdbClientSecret !== "********")
    data.igdbClientSecret = igdbClientSecret;

  // qBittorrent
  if (qbitUrl !== undefined) data.qbitUrl = qbitUrl;
  if (qbitUsername !== undefined) data.qbitUsername = qbitUsername;
  if (qbitPassword && qbitPassword !== "********") data.qbitPassword = qbitPassword;
  if (qbitCategory !== undefined) data.qbitCategory = qbitCategory;
  if (qbitSavePath !== undefined) data.qbitSavePath = qbitSavePath;

  // Prowlarr
  if (prowlarrUrl !== undefined) data.prowlarrUrl = prowlarrUrl;
  if (prowlarrApiKey && prowlarrApiKey !== "********")
    data.prowlarrApiKey = prowlarrApiKey;
  if (prowlarrAutoGrab !== undefined) data.prowlarrAutoGrab = prowlarrAutoGrab;
  if (prowlarrSearchTemplate !== undefined)
    data.prowlarrSearchTemplate = prowlarrSearchTemplate;
  if (prowlarrMinSeeders !== undefined)
    data.prowlarrMinSeeders = Number(prowlarrMinSeeders);
  if (prowlarrMaxSizeMb !== undefined)
    data.prowlarrMaxSizeMb = Number(prowlarrMaxSizeMb);
  if (prowlarrPreferredIndexers !== undefined)
    data.prowlarrPreferredIndexers = prowlarrPreferredIndexers;

  // SABnzbd
  if (sabnzbdUrl !== undefined) data.sabnzbdUrl = sabnzbdUrl;
  if (sabnzbdApiKey && sabnzbdApiKey !== "********")
    data.sabnzbdApiKey = sabnzbdApiKey;
  if (sabnzbdCategory !== undefined) data.sabnzbdCategory = sabnzbdCategory;
  if (autoApprove !== undefined) data.autoApprove = autoApprove;
  if (rommLibraryPath !== undefined) data.rommLibraryPath = rommLibraryPath;

  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      rommUrl: rommUrl ?? "",
      rommApiKey: "",
      rommUsername: rommUsername ?? "",
      rommPassword: rommPassword ?? "",
      igdbClientId: igdbClientId ?? "",
      igdbClientSecret: igdbClientSecret ?? "",
      qbitUrl: qbitUrl ?? "",
      qbitUsername: qbitUsername ?? "",
      qbitPassword: qbitPassword ?? "",
      qbitCategory: qbitCategory ?? "rommseer",
      qbitSavePath: qbitSavePath ?? "",
      prowlarrUrl: prowlarrUrl ?? "",
      prowlarrApiKey: prowlarrApiKey ?? "",
      prowlarrAutoGrab: prowlarrAutoGrab ?? false,
      prowlarrSearchTemplate: prowlarrSearchTemplate ?? "{game_name} {platform} ROM",
      prowlarrMinSeeders: prowlarrMinSeeders ?? 1,
      prowlarrMaxSizeMb: prowlarrMaxSizeMb ?? 0,
      prowlarrPreferredIndexers: prowlarrPreferredIndexers ?? "",
      sabnzbdUrl: sabnzbdUrl ?? "",
      sabnzbdApiKey: sabnzbdApiKey ?? "",
      sabnzbdCategory: sabnzbdCategory ?? "rommseer",
      autoApprove: autoApprove ?? false,
      rommLibraryPath: rommLibraryPath ?? "",
      initialized: true,
    },
    update: data,
  });

  return NextResponse.json({
    ...settings,
    rommPassword: settings.rommPassword ? "********" : "",
    igdbClientSecret: settings.igdbClientSecret ? "********" : "",
    qbitPassword: settings.qbitPassword ? "********" : "",
    prowlarrApiKey: settings.prowlarrApiKey ? "********" : "",
    sabnzbdApiKey: settings.sabnzbdApiKey ? "********" : "",
  });
}

export async function POST(req: NextRequest) {
  const rateLimited = applyRateLimit(req, "settings-post", 20, 60_000);
  if (rateLimited) return rateLimited;

  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { action } = body;

  if (action === "test-romm") {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.rommUrl) {
      return NextResponse.json(
        { success: false, error: "RomM URL not configured" },
        { status: 400 }
      );
    }
    const client = new RomMClient(
      settings.rommUrl,
      settings.rommUsername,
      settings.rommPassword
    );
    const success = await client.testConnection();
    return NextResponse.json({ success });
  }

  if (action === "test-qbit") {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.qbitUrl) {
      return NextResponse.json(
        { success: false, error: "qBittorrent URL not configured" },
        { status: 400 }
      );
    }
    try {
      const client = new QBittorrentClient(
        settings.qbitUrl,
        settings.qbitUsername,
        settings.qbitPassword
      );
      const success = await client.testConnection();
      return NextResponse.json({ success });
    } catch (error) {
      console.error("qBittorrent connection test failed:", error);
      return NextResponse.json({ success: false });
    }
  }

  if (action === "test-prowlarr") {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.prowlarrUrl) {
      return NextResponse.json(
        { success: false, error: "Prowlarr URL not configured" },
        { status: 400 }
      );
    }
    if (!settings?.prowlarrApiKey) {
      return NextResponse.json(
        { success: false, error: "Prowlarr API Key not configured. Save settings first." },
        { status: 400 }
      );
    }
    try {
      const client = new ProwlarrClient(
        settings.prowlarrUrl,
        settings.prowlarrApiKey
      );
      const success = await client.testConnection();
      if (!success) {
        console.error("Prowlarr connection test returned false. URL:", settings.prowlarrUrl);
      }
      return NextResponse.json({ success });
    } catch (error) {
      console.error("Prowlarr connection test failed:", error instanceof Error ? error.message : error);
      return NextResponse.json({ success: false, error: "Connection test failed" });
    }
  }

  if (action === "test-sabnzbd") {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.sabnzbdUrl) {
      return NextResponse.json(
        { success: false, error: "SABnzbd URL not configured" },
        { status: 400 }
      );
    }
    if (!settings?.sabnzbdApiKey) {
      return NextResponse.json(
        { success: false, error: "SABnzbd API Key not configured. Save settings first." },
        { status: 400 }
      );
    }
    try {
      const client = new SABnzbdClient(
        settings.sabnzbdUrl,
        settings.sabnzbdApiKey
      );
      const success = await client.testConnection();
      return NextResponse.json({ success });
    } catch (error) {
      console.error("SABnzbd connection test failed:", error instanceof Error ? error.message : error);
      return NextResponse.json({ success: false, error: "Connection test failed" });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
