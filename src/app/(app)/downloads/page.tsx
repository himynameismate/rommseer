"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Clock,
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  HardDrive,
  RefreshCw,
} from "lucide-react";
import { cn, formatDate, formatBytes, getStatusBadgeVariant } from "@/lib/utils";

interface DownloadItem {
  id: number;
  status: string;
  progress: number;
  error: string | null;
  stalledAt: string | null;
  downloadType: string;
  torrentHash: string | null;
  torrentName: string | null;
  magnetUrl: string | null;
  nzbId: string | null;
  indexer: string | null;
  createdAt: string;
  updatedAt: string;
  request: {
    id: number;
    status: string;
    game: {
      id: number;
      name: string;
      coverUrl: string | null;
      platform: { name: string };
    };
    user: { id: true; name: string; email: string };
  };
}

export default function DownloadsPage() {
  const { data: session } = useSession();
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("ALL");

  const fetchDownloads = useCallback(async () => {
    const res = await fetch("/api/downloads");
    if (res.ok) {
      const data = await res.json();
      setDownloads(data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchDownloads();
    // Auto-refresh every 10 seconds
    const interval = setInterval(fetchDownloads, 10000);
    return () => clearInterval(interval);
  }, [fetchDownloads]);

  const filtered = filter === "ALL"
    ? downloads
    : downloads.filter((d) => d.status === filter);

  const filters = ["ALL", "DOWNLOADING", "COMPLETED", "FAILED"];

  const stats = {
    active: downloads.filter((d) => d.status === "DOWNLOADING").length,
    completed: downloads.filter((d) => d.status === "COMPLETED").length,
    failed: downloads.filter((d) => d.status === "FAILED").length,
    stalled: downloads.filter((d) => d.status === "DOWNLOADING" && d.stalledAt).length,
  };

  if (!session || session.user.role !== "ADMIN") {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        Admin access required.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Downloads</h1>
          <p className="text-muted-foreground">
            Monitor and manage active downloads
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchDownloads}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Download className="h-4 w-4 text-blue-500" />
              <span className="text-sm text-muted-foreground">Active</span>
            </div>
            <p className="mt-1 text-2xl font-bold">{stats.active}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <span className="text-sm text-muted-foreground">Completed</span>
            </div>
            <p className="mt-1 text-2xl font-bold">{stats.completed}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              <span className="text-sm text-muted-foreground">Failed</span>
            </div>
            <p className="mt-1 text-2xl font-bold">{stats.failed}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-yellow-500" />
              <span className="text-sm text-muted-foreground">Stalled</span>
            </div>
            <p className="mt-1 text-2xl font-bold">{stats.stalled}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {filters.map((f) => (
          <Button
            key={f}
            variant={filter === f ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f === "ALL" ? "All" : f.charAt(0) + f.slice(1).toLowerCase()}
          </Button>
        ))}
      </div>

      {/* Downloads List */}
      {loading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading...
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No downloads found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((dl) => {
            const isStalled = !!dl.stalledAt;
            const stallMinutes = dl.stalledAt
              ? Math.round((Date.now() - new Date(dl.stalledAt).getTime()) / 60000)
              : 0;

            return (
              <Card key={dl.id}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    {/* Cover thumbnail */}
                    <div className="h-16 w-12 flex-shrink-0 overflow-hidden rounded bg-muted">
                      {dl.request.game.coverUrl ? (
                        <img
                          src={dl.request.game.coverUrl}
                          alt={dl.request.game.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
                          N/A
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate font-semibold">
                          {dl.request.game.name}
                        </h3>
                        <Badge variant={getStatusBadgeVariant(dl.status)}>
                          {isStalled && dl.status === "DOWNLOADING" ? "STALLED" : dl.status}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {dl.downloadType === "usenet" ? "NZB" : "Torrent"}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {dl.request.game.platform.name}
                        {dl.torrentName && ` \u00b7 ${dl.torrentName}`}
                        {dl.indexer && ` \u00b7 ${dl.indexer}`}
                        {` \u00b7 ${formatDate(dl.createdAt)}`}
                      </p>

                      {/* Progress bar */}
                      {dl.status === "DOWNLOADING" && (
                        <div className="mt-2 flex items-center gap-2">
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all duration-500",
                                isStalled ? "bg-yellow-500" : "bg-primary"
                              )}
                              style={{ width: `${Math.min(100, dl.progress * 100)}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {(dl.progress * 100).toFixed(1)}%
                          </span>
                        </div>
                      )}

                      {/* Stall indicator */}
                      {isStalled && dl.status === "DOWNLOADING" && (
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-yellow-500">
                          <Clock className="h-3 w-3" />
                          <span>Stalled for {stallMinutes}m — will retry automatically</span>
                        </div>
                      )}

                      {/* Error */}
                      {dl.error && (
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-destructive">
                          <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate" title={dl.error}>{dl.error}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
