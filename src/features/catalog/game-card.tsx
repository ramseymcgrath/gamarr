"use client";

import { Check, Gamepad2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";

import type { CatalogGameView } from "@/features/catalog/models";
import { isModifiedClick } from "@/lib/url-state";

/**
 * A real link (so new-tab and copy-link work) that, on a plain click, opens
 * the game in the Discover sheet instead of leaving the results.
 */
export function GameCard({
  game,
  href,
  selected = false,
  onSelect
}: {
  game: CatalogGameView;
  href: string;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <Link
      className="game-card"
      href={href as Route}
      scroll={false}
      aria-current={selected ? "true" : undefined}
      onClick={(event) => {
        if (!onSelect || isModifiedClick(event)) return;
        event.preventDefault();
        onSelect();
      }}
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
        {game.inLibrary && (
          // Carries its own text, not just a tick: WCAG 2.2 AA means meaning
          // is never encoded in colour or shape alone.
          <span className="in-library-badge">
            <Check aria-hidden="true" />
            In library
          </span>
        )}
      </div>
      <div>
        <h3>{game.name}</h3>
        <p>{game.releaseYear ?? "Year unknown"}</p>
      </div>
    </Link>
  );
}
