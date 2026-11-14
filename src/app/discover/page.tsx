import { getDatabase } from "@/db/client";
import { DiscoverScreen } from "@/features/catalog/discover-screen";
import { SqliteCatalogRepository } from "@/features/catalog/repository";

export const dynamic = "force-dynamic";

export default async function DiscoverPage({
  searchParams
}: {
  searchParams: Promise<{ game?: string }>;
}) {
  const { game } = await searchParams;
  const repository = new SqliteCatalogRepository(getDatabase());
  const gameId = Number(game);
  // A shared `?game=` link renders with its sheet already filled in.
  const initialGame = Number.isInteger(gameId) && gameId > 0
    ? repository.getGame(gameId)
    : null;
  return (
    <DiscoverScreen
      platforms={repository.listPlatforms()}
      initialGame={initialGame}
    />
  );
}
