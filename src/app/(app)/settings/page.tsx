"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { redirect } from "next/navigation";
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
  Loader2,
  Save,
  Server,
  Gamepad2,
  Search,
  Download,
  Newspaper,
  Settings,
} from "lucide-react";

interface SettingsData {
  rommUrl: string;
  rommUsername: string;
  rommPassword: string;
  igdbClientId: string;
  igdbClientSecret: string;
  qbitUrl: string;
  qbitUsername: string;
  qbitPassword: string;
  qbitCategory: string;
  qbitSavePath: string;
  prowlarrUrl: string;
  prowlarrApiKey: string;
  prowlarrAutoGrab: boolean;
  prowlarrSearchTemplate: string;
  prowlarrMinSeeders: number;
  prowlarrMaxSizeMb: number;
  prowlarrPreferredIndexers: string;
  prowlarrSkipFailingIndexers: boolean;
  stallDetectEnabled: boolean;
  stallDetectMinutes: number;
  sabnzbdUrl: string;
  sabnzbdApiKey: string;
  sabnzbdCategory: string;
  autoApprove: boolean;
  rommLibraryPath: string;
}

type TabKey = "general" | "romm" | "igdb" | "prowlarr" | "qbit" | "sabnzbd";

const tabs: { key: TabKey; label: string; icon: React.ReactNode; description: string }[] = [
  { key: "general", label: "General", icon: <Settings className="h-4 w-4" />, description: "General settings" },
  { key: "romm", label: "RomM", icon: <Server className="h-4 w-4" />, description: "ROM library connection" },
  { key: "igdb", label: "IGDB", icon: <Gamepad2 className="h-4 w-4" />, description: "Game discovery API" },
  { key: "prowlarr", label: "Prowlarr", icon: <Search className="h-4 w-4" />, description: "Indexer search" },
  { key: "qbit", label: "qBittorrent", icon: <Download className="h-4 w-4" />, description: "Torrent client" },
  { key: "sabnzbd", label: "SABnzbd", icon: <Newspaper className="h-4 w-4" />, description: "Usenet client" },
];

export default function SettingsPage() {
  const { data: session } = useSession();
  const [activeTab, setActiveTab] = useState<TabKey>("general");
  const [settings, setSettings] = useState<SettingsData>({
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
    prowlarrSkipFailingIndexers: true,
    stallDetectEnabled: true,
    stallDetectMinutes: 30,
    sabnzbdUrl: "",
    sabnzbdApiKey: "",
    sabnzbdCategory: "rommseer",
    autoApprove: false,
    rommLibraryPath: "",
  });
  const [saving, setSaving] = useState(false);
  const [testingRomm, setTestingRomm] = useState(false);
  const [testingQbit, setTestingQbit] = useState(false);
  const [testingProwlarr, setTestingProwlarr] = useState(false);
  const [testingSabnzbd, setTestingSabnzbd] = useState(false);
  const [rommResult, setRommResult] = useState<boolean | null>(null);
  const [qbitResult, setQbitResult] = useState<boolean | null>(null);
  const [prowlarrResult, setProwlarrResult] = useState<boolean | null>(null);
  const [sabnzbdResult, setSabnzbdResult] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);

  if (session && session.user?.role !== "ADMIN") {
    redirect("/");
  }

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings({
          rommUrl: data.rommUrl ?? "",
          rommUsername: data.rommUsername ?? "",
          rommPassword: data.rommPassword ?? "",
          igdbClientId: data.igdbClientId ?? "",
          igdbClientSecret: data.igdbClientSecret ?? "",
          qbitUrl: data.qbitUrl ?? "",
          qbitUsername: data.qbitUsername ?? "",
          qbitPassword: data.qbitPassword ?? "",
          qbitCategory: data.qbitCategory ?? "rommseer",
          qbitSavePath: data.qbitSavePath ?? "",
          prowlarrUrl: data.prowlarrUrl ?? "",
          prowlarrApiKey: data.prowlarrApiKey ?? "",
          prowlarrAutoGrab: data.prowlarrAutoGrab ?? false,
          prowlarrSearchTemplate:
            data.prowlarrSearchTemplate ?? "{game_name} {platform} ROM",
          prowlarrMinSeeders: data.prowlarrMinSeeders ?? 1,
          prowlarrMaxSizeMb: data.prowlarrMaxSizeMb ?? 0,
          prowlarrPreferredIndexers: data.prowlarrPreferredIndexers ?? "",
          prowlarrSkipFailingIndexers: data.prowlarrSkipFailingIndexers ?? true,
          stallDetectEnabled: data.stallDetectEnabled ?? true,
          stallDetectMinutes: data.stallDetectMinutes ?? 30,
          sabnzbdUrl: data.sabnzbdUrl ?? "",
          sabnzbdApiKey: data.sabnzbdApiKey ?? "",
          sabnzbdCategory: data.sabnzbdCategory ?? "rommseer",
          autoApprove: data.autoApprove ?? false,
          rommLibraryPath: data.rommLibraryPath ?? "",
        });
      })
      .catch(console.error);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });

      if (res.ok) {
        const data = await res.json();
        setSettings({
          rommUrl: data.rommUrl,
          rommUsername: data.rommUsername,
          rommPassword: data.rommPassword,
          igdbClientId: data.igdbClientId,
          igdbClientSecret: data.igdbClientSecret,
          qbitUrl: data.qbitUrl,
          qbitUsername: data.qbitUsername,
          qbitPassword: data.qbitPassword,
          qbitCategory: data.qbitCategory,
          qbitSavePath: data.qbitSavePath,
          prowlarrUrl: data.prowlarrUrl,
          prowlarrApiKey: data.prowlarrApiKey,
          prowlarrAutoGrab: data.prowlarrAutoGrab,
          prowlarrSearchTemplate: data.prowlarrSearchTemplate,
          prowlarrMinSeeders: data.prowlarrMinSeeders,
          prowlarrMaxSizeMb: data.prowlarrMaxSizeMb,
          prowlarrPreferredIndexers: data.prowlarrPreferredIndexers,
          prowlarrSkipFailingIndexers: data.prowlarrSkipFailingIndexers,
          stallDetectEnabled: data.stallDetectEnabled ?? true,
          stallDetectMinutes: data.stallDetectMinutes ?? 30,
          sabnzbdUrl: data.sabnzbdUrl,
          sabnzbdApiKey: data.sabnzbdApiKey,
          sabnzbdCategory: data.sabnzbdCategory,
          autoApprove: data.autoApprove,
          rommLibraryPath: data.rommLibraryPath ?? "",
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch {
      // Handle error silently
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (
    action: string,
    setTesting: (v: boolean) => void,
    setResult: (v: boolean | null) => void
  ) => {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      setResult(data.success);
    } catch {
      setResult(false);
    } finally {
      setTesting(false);
    }
  };

  const ConnectionBadge = ({ result }: { result: boolean | null }) => {
    if (result === null) return null;
    return (
      <Badge
        variant={result ? "default" : "destructive"}
        className="gap-1"
      >
        {result ? (
          <>
            <CheckCircle2 className="h-3 w-3" /> Connected
          </>
        ) : (
          <>
            <XCircle className="h-3 w-3" /> Failed
          </>
        )}
      </Badge>
    );
  };

  const getTabStatus = (key: TabKey): boolean | null => {
    switch (key) {
      case "romm": return rommResult;
      case "prowlarr": return prowlarrResult;
      case "qbit": return qbitResult;
      case "sabnzbd": return sabnzbdResult;
      default: return null;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          Configure your Rommseer instance
        </p>
      </div>

      <div className="space-y-6">
        {/* Horizontal tabs */}
        <nav className="flex gap-1 overflow-x-auto border-b border-border pb-px">
          {tabs.map((tab) => {
            const status = getTabStatus(tab.key);
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`relative flex items-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors ${
                  activeTab === tab.key
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {status !== null && (
                  <span
                    className={`h-2 w-2 rounded-full ${
                      status ? "bg-green-500" : "bg-red-500"
                    }`}
                  />
                )}
                {activeTab === tab.key && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                )}
              </button>
            );
          })}
        </nav>

        {/* Content area */}
        <div>
          <Card>
            <CardContent className="p-6">
              {/* RomM */}
              {/* General */}
              {activeTab === "general" && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-lg font-semibold">General</h2>
                    <p className="text-sm text-muted-foreground">
                      Global settings for your Rommseer instance
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={settings.autoApprove}
                        onClick={() =>
                          setSettings((s) => ({
                            ...s,
                            autoApprove: !s.autoApprove,
                          }))
                        }
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          settings.autoApprove
                            ? "bg-primary"
                            : "bg-muted-foreground/30"
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${
                            settings.autoApprove
                              ? "translate-x-5"
                              : "translate-x-0"
                          }`}
                        />
                      </button>
                      <label className="text-sm font-medium">
                        Auto-Approve Requests
                      </label>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      When enabled, new requests are automatically approved without
                      admin review. If Prowlarr auto-grab is also enabled, the full
                      pipeline runs automatically: request &rarr; approve &rarr; search &rarr; download.
                    </p>
                  </div>
                </div>
              )}

              {/* RomM */}
              {activeTab === "romm" && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-lg font-semibold">RomM Connection</h2>
                    <p className="text-sm text-muted-foreground">
                      Connect to your RomM instance to sync your ROM library
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2 sm:col-span-2">
                      <label className="text-sm font-medium">RomM URL</label>
                      <Input
                        placeholder="http://localhost:8080"
                        value={settings.rommUrl}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, rommUrl: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Username</label>
                      <Input
                        placeholder="Your RomM username"
                        value={settings.rommUsername}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, rommUsername: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Password</label>
                      <Input
                        type="password"
                        placeholder="Your RomM password"
                        value={settings.rommPassword}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, rommPassword: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Library Path</label>
                    <Input
                      placeholder="/romm/library"
                      value={settings.rommLibraryPath}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, rommLibraryPath: e.target.value }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Path to RomM&apos;s library directory accessible by Rommseer.
                      Downloaded ROMs will be copied here before triggering a scan.
                      Leave empty to skip copying (files stay in download client&apos;s folder).
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() =>
                        testConnection("test-romm", setTestingRomm, setRommResult)
                      }
                      disabled={testingRomm || !settings.rommUrl}
                    >
                      {testingRomm && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      Test Connection
                    </Button>
                    <ConnectionBadge result={rommResult} />
                  </div>
                </div>
              )}

              {/* IGDB */}
              {activeTab === "igdb" && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-lg font-semibold">IGDB API</h2>
                    <p className="text-sm text-muted-foreground">
                      Configure IGDB/Twitch credentials for game discovery. Get yours at{" "}
                      <a
                        href="https://dev.twitch.tv/console"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline"
                      >
                        dev.twitch.tv
                      </a>
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Client ID</label>
                      <Input
                        placeholder="Your Twitch Client ID"
                        value={settings.igdbClientId}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            igdbClientId: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Client Secret</label>
                      <Input
                        type="password"
                        placeholder="Your Twitch Client Secret"
                        value={settings.igdbClientSecret}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            igdbClientSecret: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Prowlarr */}
              {activeTab === "prowlarr" && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-lg font-semibold">Prowlarr</h2>
                    <p className="text-sm text-muted-foreground">
                      Connect to Prowlarr to automatically search indexers for ROMs
                      when requests are approved
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Prowlarr URL</label>
                      <Input
                        placeholder="http://localhost:9696"
                        value={settings.prowlarrUrl}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, prowlarrUrl: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Key</label>
                      <Input
                        type="password"
                        placeholder="Your Prowlarr API Key"
                        value={settings.prowlarrApiKey}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            prowlarrApiKey: e.target.value,
                          }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Found in Prowlarr &rarr; Settings &rarr; General &rarr; API Key
                      </p>
                    </div>
                  </div>

                  <div className="border-t pt-4">
                    <div className="flex items-center gap-3">
                      <Button
                        variant="outline"
                        onClick={() =>
                          testConnection(
                            "test-prowlarr",
                            setTestingProwlarr,
                            setProwlarrResult
                          )
                        }
                        disabled={testingProwlarr || !settings.prowlarrUrl}
                      >
                        {testingProwlarr && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Test Connection
                      </Button>
                      <ConnectionBadge result={prowlarrResult} />
                    </div>
                  </div>

                  {/* Auto-Grab section */}
                  <div className="border-t pt-4">
                    <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                      Auto-Grab
                    </h3>
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={settings.prowlarrAutoGrab}
                          onClick={() =>
                            setSettings((s) => ({
                              ...s,
                              prowlarrAutoGrab: !s.prowlarrAutoGrab,
                            }))
                          }
                          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            settings.prowlarrAutoGrab
                              ? "bg-primary"
                              : "bg-muted-foreground/30"
                          }`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${
                              settings.prowlarrAutoGrab
                                ? "translate-x-5"
                                : "translate-x-0"
                            }`}
                          />
                        </button>
                        <label className="text-sm font-medium">
                          Auto-Grab on Approve
                        </label>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        When enabled, approving a request will automatically search
                        Prowlarr and send the best result to qBittorrent (torrents)
                        or SABnzbd (NZBs). If no result is found, the request stays
                        as Approved for manual handling.
                      </p>

                      {settings.prowlarrAutoGrab && (
                        <div className="grid gap-4 pt-2 sm:grid-cols-2">
                          <div className="space-y-2 sm:col-span-2">
                            <label className="text-sm font-medium">
                              Search Template
                            </label>
                            <Input
                              placeholder="{game_name} {platform} ROM"
                              value={settings.prowlarrSearchTemplate}
                              onChange={(e) =>
                                setSettings((s) => ({
                                  ...s,
                                  prowlarrSearchTemplate: e.target.value,
                                }))
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Template for search queries. Available variables:{" "}
                              <code className="rounded bg-muted px-1">
                                {"{game_name}"}
                              </code>{" "}
                              and{" "}
                              <code className="rounded bg-muted px-1">
                                {"{platform}"}
                              </code>
                            </p>
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium">
                              Minimum Seeders
                            </label>
                            <Input
                              type="number"
                              min="0"
                              placeholder="1"
                              value={settings.prowlarrMinSeeders}
                              onChange={(e) =>
                                setSettings((s) => ({
                                  ...s,
                                  prowlarrMinSeeders: Number(e.target.value) || 0,
                                }))
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Skip torrent results with fewer seeders. Set to 0 to disable.
                            </p>
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium">
                              Max Size (MB)
                            </label>
                            <Input
                              type="number"
                              min="0"
                              placeholder="0 (no limit)"
                              value={settings.prowlarrMaxSizeMb}
                              onChange={(e) =>
                                setSettings((s) => ({
                                  ...s,
                                  prowlarrMaxSizeMb: Number(e.target.value) || 0,
                                }))
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Skip results larger than this. Set to 0 for no limit.
                            </p>
                          </div>
                          <div className="space-y-2 sm:col-span-2">
                            <label className="text-sm font-medium">
                              Preferred Indexers
                            </label>
                            <Input
                              placeholder="e.g. 1337x, RARBG (comma-separated)"
                              value={settings.prowlarrPreferredIndexers}
                              onChange={(e) =>
                                setSettings((s) => ({
                                  ...s,
                                  prowlarrPreferredIndexers: e.target.value,
                                }))
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              If a result from a preferred indexer is found, it will be
                              chosen over others.
                            </p>
                          </div>
                          <div className="flex items-center gap-3 sm:col-span-2 pt-2">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={settings.prowlarrSkipFailingIndexers}
                              onClick={() =>
                                setSettings((s) => ({
                                  ...s,
                                  prowlarrSkipFailingIndexers: !s.prowlarrSkipFailingIndexers,
                                }))
                              }
                              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                                settings.prowlarrSkipFailingIndexers
                                  ? "bg-primary"
                                  : "bg-muted-foreground/30"
                              }`}
                            >
                              <span
                                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${
                                  settings.prowlarrSkipFailingIndexers
                                    ? "translate-x-5"
                                    : "translate-x-0"
                                }`}
                              />
                            </button>
                            <label className="text-sm font-medium">
                              Skip Failing Indexers
                            </label>
                          </div>
                          <p className="text-xs text-muted-foreground sm:col-span-2">
                            Automatically skip indexers after 3 consecutive download
                            failures. They will be retried after 30 minutes. Prevents
                            wasting time on broken indexers.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* qBittorrent */}
              {activeTab === "qbit" && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-lg font-semibold">qBittorrent</h2>
                    <p className="text-sm text-muted-foreground">
                      Connect to your qBittorrent instance to download ROMs via torrents.
                      Used by Prowlarr auto-grab and manual torrent downloads.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">qBittorrent URL</label>
                      <Input
                        placeholder="http://localhost:8085"
                        value={settings.qbitUrl}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, qbitUrl: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Username</label>
                      <Input
                        placeholder="admin"
                        value={settings.qbitUsername}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            qbitUsername: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Password</label>
                      <Input
                        type="password"
                        placeholder="Your qBittorrent password"
                        value={settings.qbitPassword}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            qbitPassword: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Category</label>
                      <Input
                        placeholder="rommseer"
                        value={settings.qbitCategory}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            qbitCategory: e.target.value,
                          }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Torrents will be tagged with this category in qBittorrent
                      </p>
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <label className="text-sm font-medium">
                        Save Path (optional)
                      </label>
                      <Input
                        placeholder="/downloads/roms or leave empty for default"
                        value={settings.qbitSavePath}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            qbitSavePath: e.target.value,
                          }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Override the default save path for ROM downloads. Leave empty
                        to use qBittorrent&apos;s default.
                      </p>
                    </div>
                  </div>

                  {/* Stall Detection */}
                  <div className="border rounded-lg p-4 space-y-4">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={settings.stallDetectEnabled}
                        onClick={() =>
                          setSettings((s) => ({
                            ...s,
                            stallDetectEnabled: !s.stallDetectEnabled,
                          }))
                        }
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          settings.stallDetectEnabled
                            ? "bg-primary"
                            : "bg-muted-foreground/30"
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${
                            settings.stallDetectEnabled
                              ? "translate-x-5"
                              : "translate-x-0"
                          }`}
                        />
                      </button>
                      <div>
                        <label className="text-sm font-medium">Stall Detection</label>
                        <p className="text-xs text-muted-foreground">
                          Automatically remove and retry downloads that stall with no progress.
                        </p>
                      </div>
                    </div>
                    {settings.stallDetectEnabled && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Stall Timeout (minutes)</label>
                        <input
                          type="number"
                          min={5}
                          max={1440}
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                          value={settings.stallDetectMinutes}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              stallDetectMinutes: Number(e.target.value) || 30,
                            }))
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          If a torrent has no download speed for this many minutes, it will be removed and a new source will be tried.
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() =>
                        testConnection("test-qbit", setTestingQbit, setQbitResult)
                      }
                      disabled={testingQbit || !settings.qbitUrl}
                    >
                      {testingQbit && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      Test Connection
                    </Button>
                    <ConnectionBadge result={qbitResult} />
                  </div>
                </div>
              )}

              {/* SABnzbd */}
              {activeTab === "sabnzbd" && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-lg font-semibold">SABnzbd</h2>
                    <p className="text-sm text-muted-foreground">
                      Connect to your SABnzbd instance to download ROMs from Usenet.
                      Used by Prowlarr auto-grab when a Usenet result is found.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">SABnzbd URL</label>
                      <Input
                        placeholder="http://localhost:8080"
                        value={settings.sabnzbdUrl}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, sabnzbdUrl: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Key</label>
                      <Input
                        type="password"
                        placeholder="Your SABnzbd API Key"
                        value={settings.sabnzbdApiKey}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            sabnzbdApiKey: e.target.value,
                          }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Found in SABnzbd &rarr; Config &rarr; General &rarr; API Key
                      </p>
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <label className="text-sm font-medium">Category</label>
                      <Input
                        placeholder="rommseer"
                        value={settings.sabnzbdCategory}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            sabnzbdCategory: e.target.value,
                          }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Downloads will be tagged with this category in SABnzbd.
                        Create the category in SABnzbd first if you want a custom save path.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() =>
                        testConnection(
                          "test-sabnzbd",
                          setTestingSabnzbd,
                          setSabnzbdResult
                        )
                      }
                      disabled={testingSabnzbd || !settings.sabnzbdUrl}
                    >
                      {testingSabnzbd && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      Test Connection
                    </Button>
                    <ConnectionBadge result={sabnzbdResult} />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Save Button */}
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save Settings
            </Button>
            {saved && (
              <span className="text-sm text-green-500">Settings saved!</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
