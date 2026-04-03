import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { RomMClient } from "@/lib/romm";
import { QBittorrentClient } from "@/lib/qbittorrent";
import { ProwlarrClient } from "@/lib/prowlarr";
import { SABnzbdClient } from "@/lib/sabnzbd";
import { applyRateLimit } from "@/lib/rate-limit";
import { maskSecrets, SECRET_FIELDS } from "@/lib/constants";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) {
    return NextResponse.json({
      rommUrl: "",
      rommApiKey: "",
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
      prowlarrSkipFailingIndexers: true,
      stallDetectEnabled: true,
      stallDetectMinutes: 30,
      sabnzbdUrl: "",
      sabnzbdApiKey: "",
      sabnzbdCategory: "rommseer",
      torrentEnabled: true,
      usenetEnabled: true,
      archiveOrgEnabled: false,
      downloadPriority: "torrent,usenet,ia",
      autoApprove: false,
      rommLibraryPath: "",
      discordWebhookUrl: "",
      notifyOnRequest: true,
      notifyOnApprove: true,
      notifyOnDecline: true,
      notifyOnAvailable: true,
      notifyOnFailed: true,
      librarySyncHours: 6,
      initialized: false,
    });
  }

  return NextResponse.json(maskSecrets(settings));
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
    rommApiKey,
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
    prowlarrSkipFailingIndexers,
    stallDetectEnabled,
    stallDetectMinutes,
    sabnzbdUrl,
    sabnzbdApiKey,
    sabnzbdCategory,
    torrentEnabled,
    usenetEnabled,
    archiveOrgEnabled,
    downloadPriority,
    autoApprove,
    rommLibraryPath,
    discordWebhookUrl,
    notifyOnRequest,
    notifyOnApprove,
    notifyOnDecline,
    notifyOnAvailable,
    notifyOnFailed,
    librarySyncHours,
    prowlarrDryRun,
    registrationEnabled,
  } = body;

  // Validate URL fields use http:// or https:// schemes only
  const urlFields: Record<string, unknown> = { rommUrl, prowlarrUrl, qbitUrl, sabnzbdUrl, discordWebhookUrl };
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
  // Handle secret fields — don't overwrite with masked values
  for (const key of SECRET_FIELDS) {
    if (body[key] && body[key] !== "********") data[key] = body[key];
  }

  if (igdbClientId !== undefined) data.igdbClientId = igdbClientId;
  if (qbitUrl !== undefined) data.qbitUrl = qbitUrl;
  if (qbitUsername !== undefined) data.qbitUsername = qbitUsername;
  if (qbitCategory !== undefined) data.qbitCategory = qbitCategory;
  if (qbitSavePath !== undefined) {
    // Validate save path doesn't contain traversal sequences
    if (qbitSavePath && (qbitSavePath.includes("..") || qbitSavePath.includes("\0"))) {
      return NextResponse.json({ error: "Invalid save path" }, { status: 400 });
    }
    data.qbitSavePath = qbitSavePath;
  }

  // Prowlarr
  if (prowlarrUrl !== undefined) data.prowlarrUrl = prowlarrUrl;
  if (prowlarrAutoGrab !== undefined) data.prowlarrAutoGrab = prowlarrAutoGrab;
  if (prowlarrSearchTemplate !== undefined)
    data.prowlarrSearchTemplate = prowlarrSearchTemplate;
  if (prowlarrMinSeeders !== undefined)
    data.prowlarrMinSeeders = Number(prowlarrMinSeeders);
  if (prowlarrMaxSizeMb !== undefined)
    data.prowlarrMaxSizeMb = Number(prowlarrMaxSizeMb);
  if (prowlarrPreferredIndexers !== undefined)
    data.prowlarrPreferredIndexers = prowlarrPreferredIndexers;
  if (prowlarrSkipFailingIndexers !== undefined)
    data.prowlarrSkipFailingIndexers = prowlarrSkipFailingIndexers;
  if (stallDetectEnabled !== undefined) data.stallDetectEnabled = stallDetectEnabled;
  if (stallDetectMinutes !== undefined) data.stallDetectMinutes = Number(stallDetectMinutes);
  if (torrentEnabled !== undefined) data.torrentEnabled = torrentEnabled;
  if (usenetEnabled !== undefined) data.usenetEnabled = usenetEnabled;
  if (archiveOrgEnabled !== undefined) data.archiveOrgEnabled = archiveOrgEnabled;
  if (downloadPriority !== undefined) data.downloadPriority = downloadPriority;

  // SABnzbd
  if (sabnzbdUrl !== undefined) data.sabnzbdUrl = sabnzbdUrl;
  if (sabnzbdCategory !== undefined) data.sabnzbdCategory = sabnzbdCategory;
  if (autoApprove !== undefined) data.autoApprove = autoApprove;
  if (rommLibraryPath !== undefined) {
    if (rommLibraryPath && (rommLibraryPath.includes("..") || rommLibraryPath.includes("\0"))) {
      return NextResponse.json({ error: "Invalid library path" }, { status: 400 });
    }
    data.rommLibraryPath = rommLibraryPath;
  }

  // Discord & notifications
  if (discordWebhookUrl !== undefined) data.discordWebhookUrl = discordWebhookUrl;
  if (notifyOnRequest !== undefined) data.notifyOnRequest = notifyOnRequest;
  if (notifyOnApprove !== undefined) data.notifyOnApprove = notifyOnApprove;
  if (notifyOnDecline !== undefined) data.notifyOnDecline = notifyOnDecline;
  if (notifyOnAvailable !== undefined) data.notifyOnAvailable = notifyOnAvailable;
  if (notifyOnFailed !== undefined) data.notifyOnFailed = notifyOnFailed;
  if (librarySyncHours !== undefined) data.librarySyncHours = Number(librarySyncHours);
  if (prowlarrDryRun !== undefined) data.prowlarrDryRun = prowlarrDryRun;
  if (registrationEnabled !== undefined) data.registrationEnabled = registrationEnabled;

  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      rommUrl: rommUrl ?? "",
      rommApiKey: rommApiKey ?? "",
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
      prowlarrSkipFailingIndexers: prowlarrSkipFailingIndexers ?? true,
      stallDetectEnabled: stallDetectEnabled ?? true,
      stallDetectMinutes: stallDetectMinutes ?? 30,
      sabnzbdUrl: sabnzbdUrl ?? "",
      sabnzbdApiKey: sabnzbdApiKey ?? "",
      sabnzbdCategory: sabnzbdCategory ?? "rommseer",
      torrentEnabled: torrentEnabled ?? true,
      usenetEnabled: usenetEnabled ?? true,
      archiveOrgEnabled: archiveOrgEnabled ?? false,
      downloadPriority: downloadPriority ?? "torrent,usenet,ia",
      autoApprove: autoApprove ?? false,
      rommLibraryPath: rommLibraryPath ?? "",
      discordWebhookUrl: discordWebhookUrl ?? "",
      notifyOnRequest: notifyOnRequest ?? true,
      notifyOnApprove: notifyOnApprove ?? true,
      notifyOnDecline: notifyOnDecline ?? true,
      notifyOnAvailable: notifyOnAvailable ?? true,
      notifyOnFailed: notifyOnFailed ?? true,
      librarySyncHours: librarySyncHours ?? 6,
      prowlarrDryRun: prowlarrDryRun ?? false,
      registrationEnabled: registrationEnabled ?? false,
      initialized: true,
    },
    update: data,
  });

  return NextResponse.json(maskSecrets(settings));
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
    const client = new RomMClient(settings.rommUrl, {
      apiKey: settings.rommApiKey || undefined,
      username: settings.rommUsername || undefined,
      password: settings.rommPassword || undefined,
    });
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
