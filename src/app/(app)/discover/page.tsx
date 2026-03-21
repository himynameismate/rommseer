"use client";

import { useMemo, useState } from "react";
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

export default function DiscoverPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [requesting, setRequesting] = useState<number | null>(null);
  const [requested, setRequested] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);

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

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setSearching(true);
    setError("");
    setSelectedPlatform(null);

    try {
      const res = await fetch(
        `/api/games/search?q=${encodeURIComponent(query)}`
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
  };

  const handleRequest = async (result: SearchResult) => {
    setRequesting(result.igdbId);

    try {
      // First, ensure the game exists in our DB
      const platformSlug = result.platforms[0]?.slug ?? "unknown";
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
          platformSlug,
        }),
      });

      const game = await gameRes.json();
      const gameId = game.id;

      // Then create the request
      const reqRes = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });

      if (reqRes.ok) {
        setRequested((prev) => new Set(prev).add(result.igdbId));
      } else {
        const data = await reqRes.json();
        setError(data.error || "Failed to submit request");
      }
    } catch {
      setError("Failed to submit request");
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

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
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
                onClick={() => setSelectedPlatform(null)}
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
                onClick={() =>
                  setSelectedPlatform(
                    selectedPlatform === platform.slug ? null : platform.slug
                  )
                }
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
          {filteredResults.map((result) => (
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
                  <h3 className="line-clamp-1 font-semibold">{result.name}</h3>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {result.platforms.slice(0, 3).map((p) => (
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

                <Button
                  className="w-full"
                  size="sm"
                  disabled={
                    result.isAvailable ||
                    requested.has(result.igdbId) ||
                    requesting === result.igdbId
                  }
                  onClick={() => handleRequest(result)}
                >
                  {result.isAvailable ? (
                    <>
                      <Check className="mr-2 h-4 w-4" />
                      In Library
                    </>
                  ) : requested.has(result.igdbId) ? (
                    <>
                      <Check className="mr-2 h-4 w-4" />
                      Requested
                    </>
                  ) : requesting === result.igdbId ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Plus className="mr-2 h-4 w-4" />
                      Request
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!searching && filteredResults.length === 0 && results.length > 0 && selectedPlatform && (
        <div className="py-12 text-center text-muted-foreground">
          No results for this platform.{" "}
          <Button
            variant="link"
            className="px-1"
            onClick={() => setSelectedPlatform(null)}
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
