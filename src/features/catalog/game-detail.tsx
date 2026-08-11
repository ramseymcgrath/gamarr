"use client";

import {
  ArrowLeft,
  Gamepad2,
  Search
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { GameSearchResult } from "@/features/catalog/models";
import type { ReleaseSearchResponse } from "@/features/release-search/service";
import { ReleaseResults } from "@/features/release-search/release-results";

export function GameDetail({
  game,
  platformId,
  platformName,
  query,
  returnTo
}: {
  game: GameSearchResult;
  platformId: number;
  platformName: string;
  query: string;
  returnTo: string;
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
    <div className="page">
      <Link className="back-link" href={returnTo as Route}>
        <ArrowLeft aria-hidden="true" /> Back to results
      </Link>
      <section className="game-hero">
        <div className="detail-cover">
          {game.coverUrl ? (
            <Image src={game.coverUrl} alt="" fill sizes="280px" priority />
          ) : <Gamepad2 aria-hidden="true" />}
        </div>
        <div className="game-hero-copy">
          <p className="eyebrow">{platformName} · {game.releaseYear ?? "YEAR UNKNOWN"}</p>
          <h1>{game.name}</h1>
          <div className="genre-row">
            {game.genres.map((genre) => <span key={genre}>{genre}</span>)}
          </div>
          <p className="game-summary">{game.summary ?? "No catalog summary is available."}</p>
          <Button
            onClick={() => void search()}
            disabled={state === "searching"}
          >
            <Search aria-hidden="true" />
            {state === "searching" ? "Searching indexers…" : "Search releases"}
          </Button>
          {query && <p className="return-context mono">CATALOG QUERY: {query}</p>}
          {state === "error" && (
            <p className="error-banner">Release search failed. Check your indexers.</p>
          )}
        </div>
      </section>
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
