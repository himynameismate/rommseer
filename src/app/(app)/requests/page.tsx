"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  XCircle,
  Trash2,
  Package,
  Download,
  Loader2,
  Link2,
  Search,
  Zap,
  ArrowUpDown,
  HardDrive,
  Users,
  RotateCcw,
  Undo2,
  AlertTriangle,
  Ban,
  Clock,
  MessageSquare,
} from "lucide-react";
import { cn, formatDate, formatBytes, getStatusBadgeVariant } from "@/lib/utils";

interface DownloadInfo {
  id: number;
  status: string;
  progress: number;
  error: string | null;
  stalledAt: string | null;
  downloadType: string;
  torrentName: string | null;
  createdAt: string;
}

interface RequestItem {
  id: number;
  status: string;
  comment: string | null;
  adminNote: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string };
  game: {
    id: number;
    name: string;
    coverUrl: string | null;
    platform: { name: string };
  };
  downloads?: DownloadInfo[];
  autoGrab?: {
    success: boolean;
    message: string;
    torrentTitle?: string;
    indexer?: string;
  };
}

interface ProwlarrResult {
  guid: string;
  title: string;
  size: number;
  seeders: number | null;
  leechers: number | null;
  downloadUrl: string | null;
  magnetUrl: string | null;
  infoHash: string | null;
  indexerId: number;
  indexer: string;
  publishDate: string;
  protocol: string;
  age: number;
  grabs: number | null;
}

export default function RequestsPage() {
  const { data: session } = useSession();
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("ALL");

  // Magnet link manual input
  const [magnetInputId, setMagnetInputId] = useState<number | null>(null);
  const [magnetUrl, setMagnetUrl] = useState("");
  const [sendingTorrent, setSendingTorrent] = useState(false);

  // Prowlarr search
  const [searchingId, setSearchingId] = useState<number | null>(null);
  const [searchResults, setSearchResults] = useState<ProwlarrResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [grabbingGuid, setGrabbingGuid] = useState<string | null>(null);

  // Decline modal
  const [decliningId, setDecliningId] = useState<number | null>(null);
  const [declineNote, setDeclineNote] = useState("");

  // Auto-grab notification
  const [autoGrabMessage, setAutoGrabMessage] = useState<string | null>(null);

  const isAdmin = session?.user?.role === "ADMIN";

  const fetchRequests = useCallback(async () => {
    const params = filter !== "ALL" ? `?status=${filter}` : "";
    const res = await fetch(`/api/requests${params}`);
    const data = await res.json();
    setRequests(data);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const updateStatus = async (id: number, status: string) => {
    const res = await fetch(`/api/requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });

    if (res.ok) {
      const data = await res.json();
      // Check for auto-grab result
      if (data.autoGrab) {
        if (data.autoGrab.success) {
          setAutoGrabMessage(
            `Auto-grabbed: "${data.autoGrab.torrentTitle}" from ${data.autoGrab.indexer}`
          );
        } else {
          setAutoGrabMessage(
            `Auto-grab: ${data.autoGrab.message}`
          );
        }
        setTimeout(() => setAutoGrabMessage(null), 8000);
      }
    }

    fetchRequests();
  };

  const deleteRequest = async (id: number) => {
    await fetch(`/api/requests/${id}`, { method: "DELETE" });
    fetchRequests();
  };

  const sendToDownloadClient = async (
    requestId: number,
    url?: string,
    protocol?: string,
    extra?: { indexerId?: number; infoHash?: string | null; title?: string }
  ) => {
    const link = url || magnetUrl.trim();
    if (!link) return;

    setSendingTorrent(true);
    try {
      const res = await fetch("/api/downloads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, magnetUrl: link, protocol, ...extra }),
      });

      if (res.ok) {
        setMagnetInputId(null);
        setMagnetUrl("");
        setSearchingId(null);
        setSearchResults([]);
        setGrabbingGuid(null);
        fetchRequests();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to add download");
      }
    } catch {
      alert("Failed to send to download client");
    } finally {
      setSendingTorrent(false);
    }
  };

  const searchProwlarr = async (gameName: string, platformName: string) => {
    setSearchLoading(true);
    setSearchResults([]);
    try {
      const res = await fetch(
        `/api/prowlarr?q=${encodeURIComponent(gameName)}&platform=${encodeURIComponent(platformName)}`
      );
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data);
      } else {
        const data = await res.json();
        alert(data.error || "Prowlarr search failed");
      }
    } catch {
      alert("Failed to search Prowlarr");
    } finally {
      setSearchLoading(false);
    }
  };

  const grabResult = async (requestId: number, result: ProwlarrResult) => {
    const link = result.magnetUrl || result.downloadUrl;
    if (!link && !result.infoHash) {
      alert("No download URL available for this result");
      return;
    }
    setGrabbingGuid(result.guid);
    await sendToDownloadClient(requestId, link || "", result.protocol, {
      indexerId: result.indexerId,
      infoHash: result.infoHash,
      title: result.title,
    });
    setGrabbingGuid(null);
  };

  const declineRequest = async (id: number, note: string) => {
    const res = await fetch(`/api/requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DECLINED", adminNote: note || null }),
    });
    if (res.ok) {
      setDecliningId(null);
      setDeclineNote("");
      fetchRequests();
    }
  };

  const cancelRequest = async (id: number) => {
    const res = await fetch(`/api/requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    if (res.ok) fetchRequests();
  };

  const filters = [
    "ALL",
    "PENDING",
    "APPROVED",
    "DOWNLOADING",
    "DECLINED",
    "AVAILABLE",
    "CANCELLED",
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Requests</h1>
        <p className="text-muted-foreground">
          {isAdmin
            ? "Manage game requests from all users"
            : "Track your game requests"}
        </p>
      </div>

      {/* Auto-grab notification */}
      {autoGrabMessage && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            <span>{autoGrabMessage}</span>
          </div>
        </div>
      )}

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

      {/* Requests List */}
      {loading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          Loading...
        </div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No requests found.{" "}
            {filter !== "ALL" && (
              <Button
                variant="link"
                className="px-1"
                onClick={() => setFilter("ALL")}
              >
                Clear filter
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {requests.map((request) => (
            <Card key={request.id}>
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  {/* Cover thumbnail */}
                  <div className="h-16 w-12 flex-shrink-0 overflow-hidden rounded bg-muted">
                    {request.game.coverUrl ? (
                      <img
                        src={request.game.coverUrl}
                        alt={request.game.name}
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
                        {request.game.name}
                      </h3>
                      <Badge variant={getStatusBadgeVariant(request.status)}>
                        {request.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {request.game.platform.name}
                      {isAdmin && ` \u00b7 ${request.user.name}`}
                      {` \u00b7 ${formatDate(request.createdAt)}`}
                    </p>
                    {request.comment && (
                      <p className="mt-1 text-sm italic text-muted-foreground">
                        &ldquo;{request.comment}&rdquo;
                      </p>
                    )}

                    {/* Download progress / error / stall info */}
                    {request.downloads?.[0] && (() => {
                      const dl = request.downloads[0];
                      const isStalled = !!dl.stalledAt;
                      const stallMinutes = dl.stalledAt
                        ? Math.round((Date.now() - new Date(dl.stalledAt).getTime()) / 60000)
                        : 0;

                      return (
                        <div className="mt-2 space-y-1">
                          {/* Progress bar for active downloads */}
                          {dl.status === "DOWNLOADING" && (
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
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
                            <div className="flex items-center gap-1.5 text-xs text-yellow-500">
                              <Clock className="h-3 w-3" />
                              <span>Stalled for {stallMinutes}m — will retry automatically</span>
                            </div>
                          )}

                          {/* Error message */}
                          {dl.error && dl.status === "FAILED" && (
                            <div className="flex items-center gap-1.5 text-xs text-destructive">
                              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                              <span className="truncate" title={dl.error}>{dl.error}</span>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Actions */}
                  <div className="flex gap-1">
                    {isAdmin && request.status === "PENDING" && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-green-500 hover:text-green-600"
                          onClick={() => updateStatus(request.id, "APPROVED")}
                          title="Approve (auto-grabs if enabled)"
                        >
                          <CheckCircle2 className="h-5 w-5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-red-500 hover:text-red-600"
                          onClick={() => {
                            setDecliningId(decliningId === request.id ? null : request.id);
                            setDeclineNote("");
                          }}
                          title="Decline"
                        >
                          <XCircle className="h-5 w-5" />
                        </Button>
                      </>
                    )}
                    {isAdmin && request.status === "APPROVED" && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-orange-500 hover:text-orange-600"
                          onClick={() => {
                            if (searchingId === request.id) {
                              setSearchingId(null);
                              setSearchResults([]);
                            } else {
                              setSearchingId(request.id);
                              setMagnetInputId(null);
                              searchProwlarr(
                                request.game.name,
                                request.game.platform.name
                              );
                            }
                          }}
                          title="Search Prowlarr"
                        >
                          <Search className="h-5 w-5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-blue-500 hover:text-blue-600"
                          onClick={() => {
                            if (magnetInputId === request.id) {
                              setMagnetInputId(null);
                            } else {
                              setMagnetInputId(request.id);
                              setSearchingId(null);
                              setSearchResults([]);
                            }
                          }}
                          title="Manual magnet link"
                        >
                          <Link2 className="h-5 w-5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-purple-500 hover:text-purple-600"
                          onClick={() => updateStatus(request.id, "AVAILABLE")}
                          title="Mark as Available"
                        >
                          <Package className="h-5 w-5" />
                        </Button>
                      </>
                    )}
                    {isAdmin && request.status === "DOWNLOADING" && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-yellow-500 hover:text-yellow-600"
                          onClick={() => updateStatus(request.id, "RETRY")}
                          title="Retry auto-grab"
                        >
                          <RotateCcw className="h-5 w-5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-gray-500 hover:text-gray-600"
                          onClick={() => updateStatus(request.id, "APPROVED")}
                          title="Reset to Approved"
                        >
                          <Undo2 className="h-5 w-5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-orange-500 hover:text-orange-600"
                          onClick={() => {
                            if (searchingId === request.id) {
                              setSearchingId(null);
                              setSearchResults([]);
                            } else {
                              setSearchingId(request.id);
                              setMagnetInputId(null);
                              searchProwlarr(
                                request.game.name,
                                request.game.platform.name
                              );
                            }
                          }}
                          title="Search Prowlarr"
                        >
                          <Search className="h-5 w-5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-blue-500 hover:text-blue-600"
                          onClick={() => {
                            if (magnetInputId === request.id) {
                              setMagnetInputId(null);
                            } else {
                              setMagnetInputId(request.id);
                              setSearchingId(null);
                              setSearchResults([]);
                            }
                          }}
                          title="Manual magnet/NZB link"
                        >
                          <Link2 className="h-5 w-5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-purple-500 hover:text-purple-600"
                          onClick={() => updateStatus(request.id, "AVAILABLE")}
                          title="Mark as Available"
                        >
                          <Package className="h-5 w-5" />
                        </Button>
                      </>
                    )}
                    {/* User cancel button for pending requests */}
                    {!isAdmin && request.status === "PENDING" && request.user.id === session?.user?.id && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-yellow-500 hover:text-yellow-600"
                        onClick={() => cancelRequest(request.id)}
                        title="Cancel request"
                      >
                        <Ban className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => deleteRequest(request.id)}
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Admin note display */}
                {request.adminNote && (
                  <div className="mt-3 flex items-start gap-2 border-t pt-3">
                    <MessageSquare className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium">Admin note:</span> {request.adminNote}
                    </p>
                  </div>
                )}

                {/* Decline reason form */}
                {decliningId === request.id && (
                  <div className="mt-3 border-t pt-3 space-y-2">
                    <p className="text-sm font-medium">Decline Reason</p>
                    <div className="flex flex-wrap gap-1">
                      {["Already in library", "No sources available", "Wrong platform", "Duplicate request"].map((preset) => (
                        <Button
                          key={preset}
                          size="sm"
                          variant={declineNote === preset ? "default" : "outline"}
                          className="text-xs"
                          onClick={() => setDeclineNote(declineNote === preset ? "" : preset)}
                        >
                          {preset}
                        </Button>
                      ))}
                    </div>
                    <Input
                      placeholder="Custom reason (optional)..."
                      value={declineNote}
                      onChange={(e) => setDeclineNote(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => declineRequest(request.id, declineNote)}
                      >
                        <XCircle className="mr-1 h-3 w-3" />
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setDecliningId(null); setDeclineNote(""); }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {/* Prowlarr search results */}
                {searchingId === request.id && (
                  <div className="mt-3 border-t pt-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Search className="h-4 w-4" />
                        Prowlarr Results
                        {searchResults.length > 0 && (
                          <Badge variant="outline" className="ml-1">
                            {searchResults.length}
                          </Badge>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setSearchingId(null);
                          setSearchResults([]);
                        }}
                      >
                        Close
                      </Button>
                    </div>

                    {searchLoading ? (
                      <div className="flex items-center justify-center py-6 text-muted-foreground">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Searching indexers...
                      </div>
                    ) : searchResults.length === 0 ? (
                      <div className="py-4 text-center text-sm text-muted-foreground">
                        No results found. Try searching manually with a magnet
                        link.
                      </div>
                    ) : (
                      <div className="max-h-80 space-y-1 overflow-y-auto">
                        {searchResults.map((result) => (
                          <div
                            key={result.guid}
                            className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/50"
                          >
                            <div className="min-w-0 flex-1">
                              <p
                                className="truncate font-medium"
                                title={result.title}
                              >
                                {result.title}
                              </p>
                              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                <Badge
                                  variant="outline"
                                  className={`text-[10px] ${
                                    result.protocol === "usenet"
                                      ? "border-blue-500 text-blue-500"
                                      : "border-green-500 text-green-500"
                                  }`}
                                >
                                  {result.protocol === "usenet" ? "NZB" : "Torrent"}
                                </Badge>
                                <span className="flex items-center gap-1">
                                  <HardDrive className="h-3 w-3" />
                                  {formatBytes(result.size)}
                                </span>
                                {result.protocol !== "usenet" ? (
                                  <span className="flex items-center gap-1">
                                    <Users className="h-3 w-3" />
                                    {result.seeders ?? "?"} S / {result.leechers ?? "?"} L
                                  </span>
                                ) : (
                                  result.age > 0 && (
                                    <span>{result.age}d old</span>
                                  )
                                )}
                                <span className="flex items-center gap-1">
                                  <ArrowUpDown className="h-3 w-3" />
                                  {result.indexer}
                                </span>
                                {result.grabs != null && (
                                  <span>{result.grabs} grabs</span>
                                )}
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                grabResult(request.id, result)
                              }
                              disabled={
                                grabbingGuid === result.guid ||
                                sendingTorrent ||
                                (!result.magnetUrl && !result.downloadUrl)
                              }
                            >
                              {grabbingGuid === result.guid ? (
                                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              ) : (
                                <Download className="mr-1 h-3 w-3" />
                              )}
                              Grab
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Magnet link manual input */}
                {magnetInputId === request.id && (
                  <div className="mt-3 flex items-center gap-2 border-t pt-3">
                    <Link2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    <Input
                      placeholder="Paste magnet link or torrent URL..."
                      value={magnetUrl}
                      onChange={(e) => setMagnetUrl(e.target.value)}
                      className="flex-1"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") sendToDownloadClient(request.id);
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={() => sendToDownloadClient(request.id)}
                      disabled={sendingTorrent || !magnetUrl.trim()}
                    >
                      {sendingTorrent ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="mr-2 h-4 w-4" />
                      )}
                      Send
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setMagnetInputId(null);
                        setMagnetUrl("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
