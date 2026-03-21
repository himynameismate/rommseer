"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Loader2, Save } from "lucide-react";

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
}

export default function SettingsPage() {
  const { data: session } = useSession();
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
  });
  const [saving, setSaving] = useState(false);
  const [testingRomm, setTestingRomm] = useState(false);
  const [testingQbit, setTestingQbit] = useState(false);
  const [testingProwlarr, setTestingProwlarr] = useState(false);
  const [rommResult, setRommResult] = useState<boolean | null>(null);
  const [qbitResult, setQbitResult] = useState<boolean | null>(null);
  const [prowlarrResult, setProwlarrResult] = useState<boolean | null>(null);
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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          Configure your Rommseer instance
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* RomM Connection */}
        <Card>
          <CardHeader>
            <CardTitle>RomM Connection</CardTitle>
            <CardDescription>
              Connect to your RomM instance to sync your library
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
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
          </CardContent>
        </Card>

        {/* IGDB API */}
        <Card>
          <CardHeader>
            <CardTitle>IGDB API</CardTitle>
            <CardDescription>
              Configure IGDB/Twitch credentials for game discovery. Get yours at{" "}
              <a
                href="https://dev.twitch.tv/console"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                dev.twitch.tv
              </a>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>

        {/* Prowlarr */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Prowlarr</CardTitle>
            <CardDescription>
              Connect to Prowlarr to automatically search indexers for ROM
              torrents when requests are approved
            </CardDescription>
          </CardHeader>
          <CardContent>
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
                  Found in Prowlarr → Settings → General → API Key
                </p>
              </div>

              {/* Auto-Grab Toggle */}
              <div className="space-y-2 sm:col-span-2">
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
                  Prowlarr for the best torrent and send it to qBittorrent.
                  If no result is found, the request stays as Approved for
                  manual handling.
                </p>
              </div>

              {/* Auto-Grab Settings (only shown when enabled) */}
              {settings.prowlarrAutoGrab && (
                <>
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
                      . Example:{" "}
                      <code className="rounded bg-muted px-1">
                        {"{game_name} {platform} ROM"}
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
                      Skip results with fewer seeders than this. Set to 0 to
                      disable.
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
                      chosen over others. Comma-separated list of indexer names.
                    </p>
                  </div>
                </>
              )}
            </div>
            <div className="mt-4 flex items-center gap-3">
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
          </CardContent>
        </Card>

        {/* qBittorrent */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>qBittorrent</CardTitle>
            <CardDescription>
              Connect to your qBittorrent instance to download ROMs. Used by
              Prowlarr auto-grab and manual magnet link downloads.
            </CardDescription>
          </CardHeader>
          <CardContent>
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
            <div className="mt-4 flex items-center gap-3">
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
          </CardContent>
        </Card>
      </div>

      {/* Save Button */}
      <div className="flex items-center gap-3">
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
  );
}
