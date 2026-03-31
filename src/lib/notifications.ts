/**
 * Notification module — sends Discord webhook embeds for request/download events.
 * Designed for easy extension to email (SMTP) and in-app notifications later.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/utils";

type NotifyEvent =
  | "REQUEST_CREATED"
  | "APPROVED"
  | "DECLINED"
  | "CANCELLED"
  | "DOWNLOAD_STARTED"
  | "DOWNLOAD_COMPLETED"
  | "DOWNLOAD_FAILED"
  | "AVAILABLE";

interface NotifyPayload {
  event: NotifyEvent;
  gameName: string;
  platformName: string;
  userName: string;
  coverUrl?: string | null;
  adminNote?: string | null;
  error?: string | null;
  extra?: string;
}

const EVENT_COLORS: Record<NotifyEvent, number> = {
  REQUEST_CREATED: 0x3498db,  // blue
  APPROVED: 0x2ecc71,        // green
  DECLINED: 0xe74c3c,        // red
  CANCELLED: 0x95a5a6,       // gray
  DOWNLOAD_STARTED: 0x1abc9c,// teal
  DOWNLOAD_COMPLETED: 0x27ae60, // dark green
  DOWNLOAD_FAILED: 0xe67e22, // orange
  AVAILABLE: 0x9b59b6,       // purple
};

const EVENT_TITLES: Record<NotifyEvent, string> = {
  REQUEST_CREATED: "New Request",
  APPROVED: "Request Approved",
  DECLINED: "Request Declined",
  CANCELLED: "Request Cancelled",
  DOWNLOAD_STARTED: "Download Started",
  DOWNLOAD_COMPLETED: "Download Completed",
  DOWNLOAD_FAILED: "Download Failed",
  AVAILABLE: "Now Available",
};

function shouldNotify(
  event: NotifyEvent,
  settings: {
    notifyOnRequest: boolean;
    notifyOnApprove: boolean;
    notifyOnDecline: boolean;
    notifyOnAvailable: boolean;
    notifyOnFailed: boolean;
  }
): boolean {
  switch (event) {
    case "REQUEST_CREATED":
      return settings.notifyOnRequest;
    case "APPROVED":
    case "DOWNLOAD_STARTED":
    case "DOWNLOAD_COMPLETED":
      return settings.notifyOnApprove;
    case "DECLINED":
    case "CANCELLED":
      return settings.notifyOnDecline;
    case "AVAILABLE":
      return settings.notifyOnAvailable;
    case "DOWNLOAD_FAILED":
      return settings.notifyOnFailed;
    default:
      return false;
  }
}

/** Send a Discord webhook notification. Fire-and-forget. */
export async function notify(payload: NotifyPayload): Promise<void> {
  try {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.discordWebhookUrl) return;

    if (!shouldNotify(payload.event, settings)) return;

    // Validate webhook URL
    try {
      const url = new URL(settings.discordWebhookUrl);
      if (!["http:", "https:"].includes(url.protocol)) return;
    } catch {
      return;
    }

    const fields: { name: string; value: string; inline: boolean }[] = [
      { name: "Platform", value: payload.platformName, inline: true },
      { name: "Requested by", value: payload.userName, inline: true },
    ];

    if (payload.adminNote) {
      fields.push({ name: "Note", value: payload.adminNote, inline: false });
    }
    if (payload.error) {
      fields.push({ name: "Error", value: payload.error.slice(0, 200), inline: false });
    }
    if (payload.extra) {
      fields.push({ name: "Details", value: payload.extra, inline: false });
    }

    const embed = {
      title: `${EVENT_TITLES[payload.event]}: ${payload.gameName}`,
      color: EVENT_COLORS[payload.event],
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: "Rommseer" },
      ...(payload.coverUrl ? { thumbnail: { url: payload.coverUrl } } : {}),
    };

    const res = await fetch(settings.discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!res.ok) {
      logger.error(`[Notify] Discord webhook failed: ${res.status} ${res.statusText}`);
    }
  } catch (e) {
    logger.error(`[Notify] Error:`, e instanceof Error ? e.message : e);
  }
}

/** Record an activity log entry. Fire-and-forget safe. */
export async function logActivity(
  type: string,
  message: string,
  opts?: { userId?: string; requestId?: number; downloadId?: number; metadata?: Record<string, unknown> }
): Promise<void> {
  try {
    await prisma.activity.create({
      data: {
        type,
        message,
        userId: opts?.userId,
        requestId: opts?.requestId,
        downloadId: opts?.downloadId,
        metadata: opts?.metadata ? JSON.stringify(opts.metadata) : null,
      },
    });
  } catch (e) {
    logger.error(`[Activity] Failed to log:`, e instanceof Error ? e.message : e);
  }
}
