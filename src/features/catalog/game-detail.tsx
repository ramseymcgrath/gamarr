"use client";

import { Gamepad2, Search } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { GameSearchResult } from "@/features/catalog/models";
import type { ReleaseSearchResponse } from "@/features/release-search/service";
import { ReleaseResults } from "@/features/release-search/release-results";

/**
 * A game's details and release search, shown in the Discover side sheet.
 * Keyed by game id by its parent, so stepping to another game starts clean.
 */
export function GameDetail({
  game,
  platformId,
  platformName
}: {
  game: GameSearchResult;
  platformId: number;
  platformName: string;
}) {
  const [response, setResponse] = useState<ReleaseSearchResponse | null>(null);
  const [state, setState] = useState<"idle" | "searching" | "error">("idle");
  const search = async () => {
    setState("searching");
    try {
      const result = await fetch("/api/releases/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: game.id, platformId })
      });
      if (!result.ok) throw new Error();
      setResponse(await result.json());
      setState("idle");
    } catch {
      setState("error");
    }
  };
  return (
    <div className="game-panel">
      <section className="game-panel-hero">
        <div className="detail-cover">
          {game.coverUrl ? (
            <Image src={game.coverUrl} alt="" fill sizes="160px" priority />
          ) : <Gamepad2 aria-hidden="true" />}
        </div>
        <div className="game-hero-copy">
          <p className="game-panel-meta">
            {platformName}
            {game.releaseYear ? `, ${game.releaseYear}` : ""}
          </p>
          {game.genres.length > 0 && (
            <div className="genre-row">
              {game.genres.map((genre) => <span key={genre}>{genre}</span>)}
            </div>
          )}
          <Button
            onClick={() => void search()}
            disabled={state === "searching"}
          >
            <Search aria-hidden="true" />
            {state === "searching"
              ? "Searching releases…"
              : response ? "Search releases again" : "Search releases"}
          </Button>
        </div>
      </section>
      <p className="game-summary">{game.summary ?? "No catalog summary is available."}</p>
      {state === "error" && (
        <p className="error-banner">
          Release search failed. Check Prowlarr in Settings, then try again.
        </p>
      )}
      {response && (
        <ReleaseResults
          gameId={game.id}
          platformId={platformId}
          releases={response.releases}
          warnings={response.warnings}
          usenetClientConfigured={response.usenetClientConfigured}
          torrentClientConfigured={response.torrentClientConfigured}
        />
      )}
    </div>
  );
}
