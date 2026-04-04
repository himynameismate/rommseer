"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Search,
  Library,
  Filter,
  X,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";

interface LibraryGame {
  id: number;
  name: string;
  coverUrl: string | null;
  releaseDate: string | null;
  rating: number | null;
  platform: { id: number; name: string; slug: string };
}

interface LibraryPlatform {
  id: number;
  name: string;
  slug: string;
}

interface LibraryResponse {
  games: LibraryGame[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  platforms: LibraryPlatform[];
}

export default function LibraryPage() {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const searchRef = useRef<HTMLInputElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1); // Reset to page 1 on new search
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchLibrary = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (selectedPlatform) params.set("platform", selectedPlatform);
      params.set("page", String(page));
      params.set("pageSize", "48");

      const res = await fetch(`/api/library?${params.toString()}`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, selectedPlatform, page]);

  useEffect(() => {
    fetchLibrary();
  }, [fetchLibrary]);

  // Autofocus search on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const handlePlatformFilter = (slug: string | null) => {
    setSelectedPlatform((prev) => (prev === slug ? null : slug));
    setPage(1);
  };

  // Group games by name + igdbId for a compact display
  // (same game on multiple platforms shows as one card with multiple platform badges)
  const groupedGames = useMemo(() => {
    if (!data?.games) return [];

    const groups = new Map<
      string,
      { game: LibraryGame; platforms: LibraryPlatform[] }
    >();

    for (const game of data.games) {
      // Group by name (case-insensitive) since the same game on different platforms
      // are separate DB rows
      const key = game.name.toLowerCase();
      const existing = groups.get(key);
      if (existing) {
        // Add platform if not already present
        if (!existing.platforms.some((p) => p.slug === game.platform.slug)) {
          existing.platforms.push(game.platform);
        }
        // Keep the one with a cover
        if (!existing.game.coverUrl && game.coverUrl) {
          existing.game = game;
        }
      } else {
        groups.set(key, {
          game,
          platforms: [game.platform],
        });
      }
    }

    return Array.from(groups.values());
  }, [data?.games]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Library</h1>
        <p className="text-muted-foreground">
          {data
            ? `${data.total} game${data.total !== 1 ? "s" : ""} available in your library`
            : "Browse games available in your library"}
        </p>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          placeholder="Search library..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
        {search && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
            onClick={() => setSearch("")}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* Platform Filter */}
      {data?.platforms && data.platforms.length > 1 && (
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
            {data.platforms.map((platform) => (
              <Button
                key={platform.slug}
                variant={
                  selectedPlatform === platform.slug ? "default" : "outline"
                }
                size="sm"
                className="h-7 text-xs"
                onClick={() => handlePlatformFilter(platform.slug)}
              >
                {platform.name}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Games Grid */}
      {!loading && groupedGames.length > 0 && (
        <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {groupedGames.map(({ game, platforms }) => (
            <Card
              key={game.id}
              className="overflow-hidden transition-shadow hover:shadow-lg"
            >
              <div className="relative aspect-[3/4] w-full bg-muted">
                {game.coverUrl ? (
                  <Image
                    src={game.coverUrl}
                    alt={game.name}
                    fill
                    className="object-cover"
                    sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, 16vw"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
                    No Cover
                  </div>
                )}
              </div>
              <CardContent className="space-y-1.5 p-3">
                <h3
                  className="line-clamp-1 text-sm font-semibold"
                  title={game.name}
                >
                  {game.name}
                </h3>
                <div className="flex flex-wrap gap-1">
                  {platforms.map((p) => (
                    <Badge
                      key={p.slug}
                      variant="outline"
                      className="text-[10px]"
                    >
                      {p.name}
                    </Badge>
                  ))}
                </div>
                {game.releaseDate && (
                  <p className="text-[11px] text-muted-foreground">
                    {game.releaseDate.substring(0, 4)}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && groupedGames.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
          <Library className="mb-4 h-12 w-12 opacity-50" />
          {debouncedSearch || selectedPlatform ? (
            <>
              <p className="text-lg font-medium">No games found</p>
              <p className="mt-1 text-sm">
                Try a different search or clear your filters
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-medium">Your library is empty</p>
              <p className="mt-1 text-sm">
                Games will appear here once they&apos;re available in RomM
              </p>
            </>
          )}
        </div>
      )}

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 pt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {data.page} of {data.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= data.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
