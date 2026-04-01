"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, CheckCheck, ExternalLink } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import Link from "next/link";

interface NotificationItem {
  id: number;
  type: string;
  message: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export default function NotificationsPage() {
  const { data: session } = useSession();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchNotifications = useCallback(async () => {
    const res = await fetch("/api/notifications");
    if (res.ok) {
      const data = await res.json();
      setNotifications(data.notifications);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const markAllRead = async () => {
    const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
    if (!unreadIds.length) return;

    const res = await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: unreadIds }),
    });
    if (res.ok) fetchNotifications();
  };

  const markRead = async (id: number) => {
    const res = await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    });
    if (res.ok) fetchNotifications();
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  const typeBadgeVariant = (type: string) => {
    switch (type) {
      case "REQUEST_APPROVED":
        return "default" as const;
      case "REQUEST_DECLINED":
        return "destructive" as const;
      case "DOWNLOAD_FAILED":
        return "destructive" as const;
      case "AVAILABLE":
        return "secondary" as const;
      default:
        return "outline" as const;
    }
  };

  if (!session) return null;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Notifications</h1>
          <p className="text-muted-foreground">
            {unreadCount > 0
              ? `${unreadCount} unread notification${unreadCount !== 1 ? "s" : ""}`
              : "All caught up"}
          </p>
        </div>
        {unreadCount > 0 && (
          <Button variant="outline" size="sm" onClick={markAllRead}>
            <CheckCheck className="mr-2 h-4 w-4" />
            Mark all read
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          Loading...
        </div>
      ) : notifications.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Bell className="mx-auto mb-3 h-8 w-8 opacity-50" />
            <p>No notifications yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {notifications.map((notif) => (
            <Card
              key={notif.id}
              className={cn(!notif.read && "border-primary/30 bg-primary/5")}
            >
              <CardContent className="flex items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={typeBadgeVariant(notif.type)}>
                      {notif.type.replace(/_/g, " ")}
                    </Badge>
                    {!notif.read && (
                      <span className="h-2 w-2 rounded-full bg-primary" />
                    )}
                  </div>
                  <p className="mt-1 text-sm">{notif.message}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatDate(notif.createdAt)}
                  </p>
                </div>
                <div className="flex gap-1">
                  {notif.link && (
                    <Button size="icon" variant="ghost" asChild>
                      <Link href={notif.link}>
                        <ExternalLink className="h-4 w-4" />
                      </Link>
                    </Button>
                  )}
                  {!notif.read && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => markRead(notif.id)}
                    >
                      Mark read
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
