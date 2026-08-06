import { Check, Gamepad2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";

import type { CatalogGameView } from "@/features/catalog/models";

export function GameCard({
  game,
  href
}: {
  game: CatalogGameView;
  href: string;
}) {
  return (
    <Link className="game-card" href={href as Route}>
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
        <p>{game.releaseYear ?? "YEAR UNKNOWN"}</p>
      </div>
    </Link>
  );
}
