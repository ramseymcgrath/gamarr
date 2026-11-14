"use client";

import {
  Gamepad2,
  Search,
  SlidersHorizontal
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

import { EmptyState } from "@/components/empty-state";
import { SideSheet } from "@/components/side-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GameCard } from "@/features/catalog/game-card";
import { GameDetail } from "@/features/catalog/game-detail";
import type {
  CatalogGameView,
  GameSearchResult,
  PlatformView
} from "@/features/catalog/models";
import { updateParams, useSheetParam, useUrlParams } from "@/lib/url-state";

type SearchState = "idle" | "searching" | "done" | "error";


const CACHE_PREFIX = "gamarr:catalog-search:";

/** Back to a search shows its results at once instead of re-querying IGDB. */
function readCachedSearch(key: string): CatalogGameView[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) as CatalogGameView[] : null;
  } catch {
    return null;
  }
}

function writeCachedSearch(key: string, games: CatalogGameView[]): void {
  try {
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(games));
  } catch {
    // Storage full or disabled: the next visit simply searches again.
  }
}

export function discoverHref(input: {
  platformId: number | null;
  query?: string;
  gameId?: number | null;
}): string {
  const params = new URLSearchParams();
  if (input.platformId) params.set("platformId", String(input.platformId));
  if (input.query) params.set("q", input.query);
  if (input.gameId) params.set("game", String(input.gameId));
  const search = params.toString();
  return search ? `/discover?${search}` : "/discover";
}

export function DiscoverScreen({
  platforms,
  initialGame = null
}: {
  platforms: PlatformView[];
  /** Server-loaded when the URL opens straight onto a game's sheet. */
  initialGame?: GameSearchResult | null;
}) {
  const visible = platforms.filter((platform) => platform.visible);
  const params = useUrlParams();
  const parsedPlatform = Number(params.get("platformId"));
  const platformId = Number.isInteger(parsedPlatform) && parsedPlatform > 0
    && visible.some((platform) => platform.id === parsedPlatform)
    ? parsedPlatform
    : null;
  const query = params.get("q")?.trim() ?? "";
  const sheet = useSheetParam("game");
  const openGameId = Number(sheet.value) || null;

  // The box follows the URL (Back/Forward) until the user types over it.
  const [edit, setEdit] = useState<{ query: string; text: string } | null>(null);
  const draft = edit?.query === query ? edit.text : query;
  const setDraft = (text: string) => setEdit({ query, text });
  const [searchNonce, setSearchNonce] = useState(0);
  const searchKey = platformId && query
    ? `${platformId}:${query.toLowerCase()}#${searchNonce}`
    : null;
  const [searchResult, setSearchResult] = useState<{
    key: string;
    games: CatalogGameView[] | "error";
  } | null>(null);
  const [popularResult, setPopularResult] = useState<{
    platformId: number;
    games: CatalogGameView[] | "error";
  } | null>(null);
  const [fetchedGame, setFetchedGame] = useState<GameSearchResult | null>(initialGame);

  // Each result is tagged with the search it answers, so only the search the
  // URL names right now is ever shown.
  const settled = searchKey && searchResult?.key === searchKey ? searchResult : null;
  const state: SearchState = !searchKey
    ? "idle"
    : !settled ? "searching" : settled.games === "error" ? "error" : "done";
  const results = settled && settled.games !== "error" ? settled.games : [];

  // The URL is the search: whenever its platform+query change, show them.
  useEffect(() => {
    if (!searchKey || !platformId) return;
    const cacheKey = searchKey.slice(0, searchKey.lastIndexOf("#"));
    const cached = searchNonce === 0 ? readCachedSearch(cacheKey) : null;
    const controller = new AbortController();
    const load = cached
      ? Promise.resolve(cached)
      : fetch(`/api/catalog/search?${new URLSearchParams({
        platformId: String(platformId),
        query
      })}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("Search failed");
          const games: CatalogGameView[] = await response.json();
          writeCachedSearch(cacheKey, games);
          return games;
        });
    load
      .then((games) => {
        if (!controller.signal.aborted) setSearchResult({ key: searchKey, games });
      })
      .catch(() => {
        if (!controller.signal.aborted) setSearchResult({ key: searchKey, games: "error" });
      });
    return () => controller.abort();
  }, [searchKey, platformId, query, searchNonce]);

  useEffect(() => {
    if (!platformId) return;
    // Without this, clicking quickly between platforms lets a slow response
    // land after a fast one. The platform tag on the result makes a late
    // write harmless, but aborting also stops the wasted parse.
    const controller = new AbortController();
    fetch(`/api/catalog/popular?platformId=${platformId}`, {
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Popular fetch failed");
        setPopularResult({ platformId, games: await response.json() });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setPopularResult({ platformId, games: "error" });
      });
    return () => controller.abort();
  }, [platformId]);

  const platformName = visible.find(
    (platform) => platform.id === platformId
  )?.name ?? "";
  // Only a result tagged with the platform now selected may be shown.
  const current = popularResult?.platformId === platformId
    ? popularResult
    : null;
  const popularState: "loading" | "error" | "idle" = current
    ? (current.games === "error" ? "error" : "idle")
    : "loading";
  const popular = current && current.games !== "error" ? current.games : [];
  const showPopular = state === "idle" && platformId !== null && (
    popularState !== "idle" || popular.length > 0
  );
  const recent = visible.slice(0, 7);

  // The sheet steps through whichever list the game was opened from.
  const browsing: GameSearchResult[] = results.length > 0 ? results : popular;
  const openIndex = browsing.findIndex((game) => game.id === openGameId);
  const stepping = openIndex >= 0 && browsing.length > 1;
  const openGame = openIndex >= 0
    ? browsing[openIndex]!
    : fetchedGame?.id === openGameId ? fetchedGame : null;

  // A shared link can open a game that isn't in any list on screen.
  useEffect(() => {
    if (!openGameId || openIndex >= 0 || fetchedGame?.id === openGameId) return;
    const controller = new AbortController();
    fetch(`/api/catalog/games/${openGameId}`, {
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => {
        if (response.ok) setFetchedGame(await response.json());
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [openGameId, openIndex, fetchedGame]);

  const choosePlatform = (id: number | null) => {
    // Refines the current step: switching consoles shouldn't need two Backs.
    updateParams({ platformId: id, game: null }, "replace");
  };

  const updateDraft = (value: string) => {
    setDraft(value);
    // Emptying the box returns Discover to its browse state, so the shelf is
    // the real empty state for search rather than a one-shot splash.
    if (!value.trim() && query) updateParams({ q: null, game: null }, "replace");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (!platformId || !next) return;
    if (next === query) {
      setSearchNonce((value) => value + 1);
      return;
    }
    // A new search is a new Back step: Back returns to the previous one.
    updateParams({ q: next, game: null }, "push");
  };

  const cardHref = (game: GameSearchResult) =>
    discoverHref({ platformId, query, gameId: game.id });

  return (
    <div className="page">
      <header className="page-header discover-header">
        <div>
          <h1>Find a game.</h1>
          <p>
            Choose the console, then search the IGDB catalog. Gamarr keeps
            that console attached when it matches releases.
          </p>
        </div>
        <span className="catalog-count mono">
          {visible.length} {visible.length === 1 ? "platform" : "platforms"}
        </span>
      </header>

      {visible.length === 0 ? (
        <EmptyState
          title="Your console shelf is empty"
          action={<Button asChild><Link href="/setup">Continue setup</Link></Button>}
        >
          Refresh IGDB platforms and choose at least one console before
          searching.
        </EmptyState>
      ) : (
        <>
          <section aria-labelledby="platform-heading" className="platform-selector">
            <div className="section-label-row">
              <h2 id="platform-heading">Console</h2>
              <label className="platform-overflow">
                <SlidersHorizontal aria-hidden="true" />
                <span className="sr-only">All platforms</span>
                <select
                  aria-label="All platforms"
                  value={platformId ?? ""}
                  onChange={(event) => choosePlatform(
                    event.target.value ? Number(event.target.value) : null
                  )}
                >
                  <option value="">All platforms…</option>
                  {visible.map((platform) => (
                    <option value={platform.id} key={platform.id}>
                      {platform.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="media-shelf" role="group" aria-label="Recent platforms">
              {recent.map((platform, index) => (
                <button
                  type="button"
                  aria-pressed={platformId === platform.id}
                  className="media-spine"
                  style={{ "--spine-index": index } as React.CSSProperties}
                  onClick={() => choosePlatform(platform.id)}
                  key={platform.id}
                >
                  <Gamepad2 aria-hidden="true" />
                  <span>{platform.name}</span>
                  <small>{platform.abbreviation ?? "SYSTEM"}</small>
                </button>
              ))}
            </div>
          </section>

          <form className="catalog-search" onSubmit={submit} role="search">
            <label htmlFor="game-query">Search the catalog</label>
            <Input
              id="game-query"
              type="search"
              role="searchbox"
              value={draft}
              onChange={(event) => updateDraft(event.target.value)}
              placeholder={platformId
                ? "Metroid Prime 4, Forza, Final Fantasy…"
                : "Choose a console first"}
            />
            <Button
              type="submit"
              disabled={!platformId || !draft.trim() || state === "searching"}
            >
              <Search aria-hidden="true" />
              {state === "searching" ? "Searching…" : "Search games"}
            </Button>
          </form>

          {showPopular && (
            <section
              aria-labelledby="popular-heading"
              aria-busy={popularState === "loading"}
              className="catalog-results"
            >
              <div className="result-heading">
                <h2 id="popular-heading">Popular on {platformName}</h2>
              </div>
              {popularState === "loading" && (
                <p className="popular-note">Loading popular titles…</p>
              )}
              {popularState === "error" && (
                <p className="popular-note">Couldn&apos;t load popular titles.</p>
              )}
              {popular.length > 0 && (
                <div className="game-grid">
                  {popular.map((game) => (
                    <GameCard
                      game={game}
                      href={cardHref(game)}
                      selected={game.id === openGameId}
                      onSelect={() => sheet.open(game.id)}
                      key={game.id}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          <section aria-live="polite" className="catalog-results">
            {state === "error" && (
              <p className="error-banner">
                Catalog search failed. Check IGDB in Settings, then search again.
              </p>
            )}
            {state === "done" && results.length === 0 && (
              <EmptyState title={`Nothing on ${platformName} matches “${query}”`}>
                Try the full title, a shorter title, or another console.
              </EmptyState>
            )}
            {results.length > 0 && (
              <>
                <div className="result-heading">
                  <h2>
                    {results.length} {results.length === 1 ? "match" : "matches"} for “{query}”
                  </h2>
                </div>
                <div className="game-grid">
                  {results.map((game) => (
                    <GameCard
                      game={game}
                      href={cardHref(game)}
                      selected={game.id === openGameId}
                      onSelect={() => sheet.open(game.id)}
                      key={game.id}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        </>
      )}

      <SideSheet
        open={openGameId !== null && platformId !== null}
        onClose={sheet.close}
        title={openGame?.name ?? "Loading game…"}
        position={stepping ? `${openIndex + 1} of ${browsing.length}` : undefined}
        onPrevious={stepping
          ? (openIndex > 0 ? () => sheet.step(browsing[openIndex - 1]!.id) : null)
          : undefined}
        onNext={stepping
          ? (openIndex < browsing.length - 1
            ? () => sheet.step(browsing[openIndex + 1]!.id)
            : null)
          : undefined}
      >
        {openGame && platformId !== null ? (
          <GameDetail
            key={openGame.id}
            game={openGame}
            platformId={platformId}
            platformName={platformName}
          />
        ) : (
          <p className="popular-note">Loading game…</p>
        )}
      </SideSheet>
    </div>
  );
}
