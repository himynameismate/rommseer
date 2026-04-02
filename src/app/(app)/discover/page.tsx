"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Search, Star, Plus, Check, Loader2, Filter, X } from "lucide-react";

interface SearchResult {
  igdbId: number;
  name: string;
  summary: string | null;
  coverUrl: string | null;
  releaseDate: string | null;
  rating: number | null;
  platforms: { id: number; name: string; slug: string }[];
  dbId: number | null;
  isAvailable: boolean;
  requestCount: number;
}

function DiscoverContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [requesting, setRequesting] = useState<string | null>(null); // "igdbId-platformSlug"
  const [requested, setRequested] = useState<Set<string>>(new Set()); // "igdbId-platformSlug"
  const [error, setError] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(
    searchParams.get("platform") || null
  );
  const [pickingPlatform, setPickingPlatform] = useState<number | null>(null); // igdbId of game showing platform picker
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const initialSearchDone = useRef(false);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Autofocus search input on mount
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Load existing requests to pre-populate "requested" state
  useEffect(() => {
    fetch("/api/requests")
      .then((r) => r.json())
      .then((data: { game: { igdbId?: number; platform: { slug: string } } }[]) => {
        const keys = new Set<string>();
        data.forEach((req) => {
          if (req.game.igdbId) {
            keys.add(`${req.game.igdbId}-${req.game.platform.slug}`);
          }
        });
        if (keys.size > 0) {
          setRequested((prev) => {
            const merged = new Set(prev);
            keys.forEach((k) => merged.add(k));
            return merged;
          });
        }
      })
      .catch(() => {}); // silently fail — non-critical
  }, []);

  // Update URL params when search/filter changes
  const updateUrl = useCallback(
    (q: string, platform: string | null) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (platform) params.set("platform", platform);
      const search = params.toString();
      router.replace(`/discover${search ? `?${search}` : ""}`, { scroll: false });
    },
    [router]
  );

  // Extract unique platforms from results
  const availablePlatforms = useMemo(() => {
    const platformMap = new Map<string, { id: number; name: string; slug: string }>();
    results.forEach((r) => {
      r.platforms.forEach((p) => {
        if (!platformMap.has(p.slug)) {
          platformMap.set(p.slug, p);
        }
      });
    });
    // Sort alphabetically
    return Array.from(platformMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [results]);

  // Filter results by selected platform
  const filteredResults = useMemo(() => {
    if (!selectedPlatform) return results;
    return results.filter((r) =>
      r.platforms.some((p) => p.slug === selectedPlatform)
    );
  }, [results, selectedPlatform]);

  const doSearch = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery.trim()) return;

      setSearching(true);
      setError("");

      try {
        const res = await fetch(
          `/api/games/search?q=${encodeURIComponent(searchQuery)}`
        );
        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "Search failed");
          setResults([]);
        } else {
          setResults(data);
        }
      } catch {
        setError("Failed to search. Check your IGDB configuration.");
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    []
  );

  // Auto-search on mount if q param present
  useEffect(() => {
    if (initialSearchDone.current) return;
    initialSearchDone.current = true;
    const q = searchParams.get("q");
    if (q) {
      doSearch(q);
    }
  }, [searchParams, doSearch]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSelectedPlatform(null);
    updateUrl(query, null);
    await doSearch(query);
  };

  const handlePlatformFilter = (slug: string | null) => {
    const newPlatform = selectedPlatform === slug ? null : slug;
    setSelectedPlatform(newPlatform);
    updateUrl(query, newPlatform);
  };

  const handleRequest = async (result: SearchResult, platform: { id: number; name: string; slug: string }) => {
    const key = `${result.igdbId}-${platform.slug}`;
    setRequesting(key);
    setPickingPlatform(null);

    try {
      const gameRes = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          igdbId: result.igdbId,
          name: result.name,
          summary: result.summary,
          coverUrl: result.coverUrl,
          releaseDate: result.releaseDate,
          rating: result.rating,
          platformSlug: platform.slug,
          platformName: platform.name,
        }),
      });

      const game = await gameRes.json();

      const reqRes = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: game.id }),
      });

      if (reqRes.ok) {
        setRequested((prev) => new Set(prev).add(key));
        setToast({ message: `Requested ${result.name} (${platform.name})`, type: "success" });
      } else {
        const data = await reqRes.json();
        setToast({ message: data.error || "Failed to submit request", type: "error" });
      }
    } catch {
      setToast({ message: "Failed to submit request", type: "error" });
    } finally {
      setRequesting(null);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Discover</h1>
        <p className="text-muted-foreground">
          Search for games and request them for your library
        </p>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 rounded-md px-4 py-3 text-sm shadow-lg transition-opacity ${
            toast.type === "success"
              ? "bg-green-600 text-white"
              : "bg-destructive text-destructive-foreground"
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            placeholder="Search for a game..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button type="submit" disabled={searching}>
          {searching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Search"
          )}
        </Button>
      </form>

      {error && (
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Platform Filter */}
      {availablePlatforms.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Filter className="h-4 w-4" />
            <span>Filter by platform</span>
            {selectedPlatform && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={() => handlePlatformFilter(null)}
              >
                <X className="h-3 w-3" />
                Clear
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {availablePlatforms.map((platform) => (
              <Button
                key={platform.slug}
                variant={selectedPlatform === platform.slug ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => handlePlatformFilter(platform.slug)}
              >
                {platform.name}
              </Button>
            ))}
          </div>
          {selectedPlatform && (
            <p className="text-xs text-muted-foreground">
              Showing {filteredResults.length} of {results.length} results
            </p>
          )}
        </div>
      )}

      {/* Results */}
      {filteredResults.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredResults.map((result) => {
            // Sort platforms: active filter first
            const sortedPlatforms = selectedPlatform
              ? [...result.platforms].sort((a, b) => {
                  if (a.slug === selectedPlatform && b.slug !== selectedPlatform) return -1;
                  if (b.slug === selectedPlatform && a.slug !== selectedPlatform) return 1;
                  return a.name.localeCompare(b.name);
                })
              : result.platforms;

            // Count unrequested platforms for multi-platform button
            const unrequestedPlatforms = result.platforms.filter(
              (p) => !requested.has(`${result.igdbId}-${p.slug}`)
            );
            const allRequested = unrequestedPlatforms.length === 0;

            return (
              <Card
                key={result.igdbId}
                className="overflow-hidden transition-shadow hover:shadow-lg"
              >
                <div className="relative aspect-[3/4] w-full bg-muted">
                  {result.coverUrl ? (
                    <Image
                      src={result.coverUrl}
                      alt={result.name}
                      fill
                      className="object-cover"
                      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      No Cover
                    </div>
                  )}
                  {result.isAvailable && (
                    <Badge className="absolute right-2 top-2 bg-green-600">
                      Available
                    </Badge>
                  )}
                </div>
                <CardContent className="space-y-3 p-4">
                  <div>
                    <h3 className="line-clamp-1 font-semibold" title={result.name}>
                      {result.name}
                    </h3>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {sortedPlatforms.slice(0, 3).map((p) => (
                        <Badge
                          key={p.id}
                          variant="outline"
                          className={`text-[10px] ${
                            selectedPlatform === p.slug
                              ? "border-primary text-primary"
                              : ""
                          }`}
                        >
                          {p.name}
                        </Badge>
                      ))}
                      {result.platforms.length > 3 && (
                        <Badge variant="outline" className="text-[10px]">
                          +{result.platforms.length - 3}
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    {result.releaseDate && (
                      <span>{result.releaseDate.substring(0, 4)}</span>
                    )}
                    {result.rating && (
                      <span className="flex items-center gap-1">
                        <Star className="h-3 w-3 fill-yellow-500 text-yellow-500" />
                        {result.rating}
                      </span>
                    )}
                  </div>

                  {result.summary && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {result.summary}
                    </p>
                  )}

                  {/* Platform picker or single-platform request button */}
                  {result.isAvailable ? (
                    <Button className="w-full" size="sm" disabled>
                      <Check className="mr-2 h-4 w-4" />
                      In Library
                    </Button>
                  ) : pickingPlatform === result.igdbId ? (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground text-center">Select platform:</p>
                      {sortedPlatforms.map((p) => {
                        const key = `${result.igdbId}-${p.slug}`;
                        const done = requested.has(key);
                        const loading = requesting === key;
                        return (
                          <Button
                            key={p.slug}
                            className="w-full justify-start"
                            size="sm"
                            variant={done ? "secondary" : "outline"}
                            disabled={done || loading}
                            onClick={() => handleRequest(result, p)}
                          >
                            {loading ? (
                              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                            ) : done ? (
                              <Check className="mr-2 h-3 w-3" />
                            ) : (
                              <Plus className="mr-2 h-3 w-3" />
                            )}
                            <span className="truncate">{p.name}</span>
                          </Button>
                        );
                      })}
                      <Button
                        className="w-full"
                        size="sm"
                        variant="ghost"
                        onClick={() => setPickingPlatform(null)}
                      >
                        <X className="mr-2 h-3 w-3" />
                        Cancel
                      </Button>
                    </div>
                  ) : result.platforms.length === 1 ? (
                    <Button
                      className="w-full"
                      size="sm"
                      disabled={requested.has(`${result.igdbId}-${result.platforms[0].slug}`) || requesting === `${result.igdbId}-${result.platforms[0].slug}`}
                      onClick={() => handleRequest(result, result.platforms[0])}
                    >
                      {requested.has(`${result.igdbId}-${result.platforms[0].slug}`) ? (
                        <>
                          <Check className="mr-2 h-4 w-4" />
                          Requested
                        </>
                      ) : requesting === `${result.igdbId}-${result.platforms[0].slug}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <Plus className="mr-2 h-4 w-4" />
                          Request
                        </>
                      )}
                    </Button>
                  ) : allRequested ? (
                    <Button className="w-full" size="sm" disabled>
                      <Check className="mr-2 h-4 w-4" />
                      Requested
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      size="sm"
                      onClick={() => setPickingPlatform(result.igdbId)}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Request ({unrequestedPlatforms.length} platform{unrequestedPlatforms.length !== 1 ? "s" : ""})
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {!searching && filteredResults.length === 0 && results.length > 0 && selectedPlatform && (
        <div className="py-12 text-center text-muted-foreground">
          No results for this platform.{" "}
          <Button
            variant="link"
            className="px-1"
            onClick={() => handlePlatformFilter(null)}
          >
            Clear filter
          </Button>
        </div>
      )}

      {!searching && results.length === 0 && query && !error && (
        <div className="py-12 text-center text-muted-foreground">
          No results found for &ldquo;{query}&rdquo;
        </div>
      )}

      {!query && (
        <div className="py-12 text-center text-muted-foreground">
          Search for a game above to get started
        </div>
      )}
    </div>
  );
}

export default function DiscoverPage() {
  return (
    <Suspense>
      <DiscoverContent />
    </Suspense>
  );
}
