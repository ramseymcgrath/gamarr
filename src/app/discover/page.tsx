import { getDatabase } from "@/db/client";
import { DiscoverScreen } from "@/features/catalog/discover-screen";
import { SqliteCatalogRepository } from "@/features/catalog/repository";

export const dynamic = "force-dynamic";

export default async function DiscoverPage({
  searchParams
}: {
  searchParams: Promise<{ platformId?: string; q?: string }>;
}) {
  const parameters = await searchParams;
  const parsedPlatform = Number(parameters.platformId);
  return (
    <DiscoverScreen
      platforms={new SqliteCatalogRepository(getDatabase()).listPlatforms()}
      initialQuery={parameters.q ?? ""}
      initialPlatformId={Number.isInteger(parsedPlatform) && parsedPlatform > 0
        ? parsedPlatform
        : null}
    />
  );
}
