"use client";

import {
  Gamepad2,
  Search,
  SlidersHorizontal
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { useState, type FormEvent } from "react";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  GameSearchResult,
  PlatformView
} from "@/features/catalog/models";

export function DiscoverScreen({
  platforms,
  initialQuery = "",
  initialPlatformId = null
}: {
  platforms: PlatformView[];
  initialQuery?: string;
  initialPlatformId?: number | null;
}) {
  const visible = platforms.filter((platform) => platform.visible);
  const [query, setQuery] = useState(initialQuery);
  const [platformId, setPlatformId] = useState<number | null>(initialPlatformId);
  const [results, setResults] = useState<GameSearchResult[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const recent = visible.slice(0, 7);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!platformId || !query.trim()) return;
    setState("searching");
    const parameters = new URLSearchParams({
      platformId: String(platformId),
      query: query.trim()
    });
    history.replaceState(null, "", `/discover?platformId=${platformId}&q=${encodeURIComponent(query.trim())}`);
    try {
      const response = await fetch(`/api/catalog/search?${parameters}`, {
        cache: "no-store"
      });
      if (!response.ok) throw new Error("Search failed");
      setResults(await response.json());
      setState("done");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="page">
      <header className="page-header discover-header">
        <div>
          <p className="eyebrow">CATALOG TERMINAL</p>
          <h1>Find a game.</h1>
          <p>
            Choose the original platform, then search the IGDB catalog.
            Gamarr keeps that console attached through release matching.
          </p>
        </div>
        <span className="catalog-count mono">{visible.length} PLATFORMS ONLINE</span>
      </header>

      {visible.length === 0 ? (
        <EmptyState
          eyebrow="NO PLATFORMS"
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
              <div>
                <p className="eyebrow">STEP 01</p>
                <h2 id="platform-heading">Choose a platform</h2>
              </div>
              <label className="platform-overflow">
                <SlidersHorizontal aria-hidden="true" />
                <span className="sr-only">All platforms</span>
                <select
                  aria-label="All platforms"
                  value={platformId ?? ""}
                  onChange={(event) => setPlatformId(
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
                  onClick={() => setPlatformId(platform.id)}
                  key={platform.id}
                >
                  <Gamepad2 aria-hidden="true" />
                  <span>{platform.name}</span>
                  <small>{platform.abbreviation ?? "SYSTEM"}</small>
                </button>
              ))}
            </div>
          </section>

          <form className="catalog-search" onSubmit={search}>
            <div>
              <p className="eyebrow">STEP 02</p>
              <label htmlFor="game-query">Search the catalog</label>
            </div>
            <Input
              id="game-query"
              type="search"
              role="searchbox"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Metroid Prime 4, Forza, Final Fantasy…"
            />
            <Button
              type="submit"
              disabled={!platformId || !query.trim() || state === "searching"}
            >
              <Search aria-hidden="true" />
              {state === "searching" ? "Searching…" : "Search games"}
            </Button>
          </form>

          <section aria-live="polite" className="catalog-results">
            {state === "error" && (
              <p className="error-banner">Catalog search failed. Check IGDB in Settings.</p>
            )}
            {state === "done" && results.length === 0 && (
              <EmptyState title="No catalog matches">
                Try the full title, a shorter title, or another platform.
              </EmptyState>
            )}
            {results.length > 0 && (
              <>
                <div className="result-heading">
                  <h2>{results.length} catalog matches</h2>
                  <span className="mono">SELECT A GAME TO CONTINUE</span>
                </div>
                <div className="game-grid">
                  {results.map((game) => (
                    <Link
                      className="game-card"
                      href={`/discover/${game.id}?platformId=${platformId}&q=${encodeURIComponent(query)}&returnTo=${encodeURIComponent(`/discover?platformId=${platformId}&q=${query}`)}` as Route}
                      key={game.id}
                    >
                      <div className="game-cover">
                        {game.coverUrl ? (
                          <Image
                            src={game.coverUrl}
                            alt=""
                            fill
                            sizes="(max-width: 720px) 45vw, 220px"
                          />
                        ) : (
                          <Gamepad2 aria-hidden="true" />
                        )}
                      </div>
                      <div>
                        <h3>{game.name}</h3>
                        <p>{game.releaseYear ?? "YEAR UNKNOWN"}</p>
                      </div>
                    </Link>
                  ))}
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
