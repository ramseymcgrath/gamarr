import { notFound } from "next/navigation";

import { getDatabase } from "@/db/client";
import { GameDetail } from "@/features/catalog/game-detail";
import { SqliteCatalogRepository } from "@/features/catalog/repository";

export const dynamic = "force-dynamic";

export default async function GameDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<{
    platformId?: string;
    q?: string;
    returnTo?: string;
  }>;
}) {
  const [{ gameId }, query] = await Promise.all([params, searchParams]);
  const repository = new SqliteCatalogRepository(getDatabase());
  const game = repository.getGame(Number(gameId));
  const platformId = Number(query.platformId);
  const platform = repository.getPlatform(platformId);
  if (
    !game ||
    !platform ||
    !platform.visible ||
    !game.platformIds.includes(platformId)
  ) {
    notFound();
  }
  const fallback = `/discover?platformId=${platformId}&q=${encodeURIComponent(query.q ?? "")}`;
  const returnTo = query.returnTo?.startsWith("/discover")
    ? query.returnTo
    : fallback;
  return (
    <GameDetail
      game={game}
      platformId={platformId}
      platformName={platform.name}
      query={query.q ?? ""}
      returnTo={returnTo}
    />
  );
}
