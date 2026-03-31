"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  XCircle,
  Download,
  AlertTriangle,
  Package,
  Clock,
  RotateCcw,
  Ban,
  ListTodo,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

interface ActivityItem {
  id: number;
  type: string;
  message: string;
  metadata: string | null;
  createdAt: string;
  user: { id: string; name: string } | null;
  request: {
    id: number;
    game: { name: string; coverUrl: string | null; platform: { name: string } };
  } | null;
}

const TYPE_ICONS: Record<string, typeof CheckCircle2> = {
  REQUEST_CREATED: ListTodo,
  APPROVED: CheckCircle2,
  DECLINED: XCircle,
  CANCELLED: Ban,
  DOWNLOAD_STARTED: Download,
  DOWNLOAD_COMPLETED: CheckCircle2,
  DOWNLOAD_FAILED: AlertTriangle,
  DOWNLOAD_STALLED: Clock,
  AVAILABLE: Package,
  RETRY: RotateCcw,
};

const TYPE_COLORS: Record<string, string> = {
  REQUEST_CREATED: "text-blue-500",
  APPROVED: "text-green-500",
  DECLINED: "text-red-500",
  CANCELLED: "text-gray-500",
  DOWNLOAD_STARTED: "text-cyan-500",
  DOWNLOAD_COMPLETED: "text-green-600",
  DOWNLOAD_FAILED: "text-orange-500",
  DOWNLOAD_STALLED: "text-yellow-500",
  AVAILABLE: "text-purple-500",
  RETRY: "text-yellow-600",
};

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ActivityPage() {
  const { data: session } = useSession();
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 50;

  const fetchActivities = useCallback(async () => {
    const res = await fetch(`/api/activity?page=${page}&limit=${limit}`);
    if (res.ok) {
      const data = await res.json();
      setActivities(data.activities);
      setTotal(data.total);
    }
    setLoading(false);
  }, [page]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  if (!session || session.user.role !== "ADMIN") {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        Admin access required.
      </div>
    );
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Activity</h1>
          <p className="text-muted-foreground">
            Recent events across all requests and downloads
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchActivities}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          Loading...
        </div>
      ) : activities.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No activity recorded yet.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-2">
            {activities.map((activity) => {
              const Icon = TYPE_ICONS[activity.type] || ListTodo;
              const color = TYPE_COLORS[activity.type] || "text-muted-foreground";

              return (
                <div
                  key={activity.id}
                  className="flex items-start gap-3 rounded-lg border px-4 py-3"
                >
                  <div className={`mt-0.5 ${color}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{activity.message}</p>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{formatRelativeTime(activity.createdAt)}</span>
                      {activity.request && (
                        <>
                          <span>&middot;</span>
                          <Badge variant="outline" className="text-[10px]">
                            {activity.request.game.platform.name}
                          </Badge>
                        </>
                      )}
                      {activity.user && (
                        <>
                          <span>&middot;</span>
                          <span>{activity.user.name}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {activity.request?.game.coverUrl && (
                    <div className="h-10 w-8 flex-shrink-0 overflow-hidden rounded bg-muted">
                      <img
                        src={activity.request.game.coverUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
