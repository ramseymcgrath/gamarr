import { Gamepad2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";

import type { GameSearchResult } from "@/features/catalog/models";

export function GameCard({
  game,
  href
}: {
  game: GameSearchResult;
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
      </div>
      <div>
        <h3>{game.name}</h3>
        <p>{game.releaseYear ?? "YEAR UNKNOWN"}</p>
      </div>
    </Link>
  );
}
