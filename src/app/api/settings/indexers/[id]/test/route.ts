import { settingsDependencies } from "@/app/api/settings/dependencies";
import { handleTestIndexer } from "@/app/api/settings/indexers/test-handler";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { NewznabClient } from "@/integrations/newznab/client";
import { getDatabase } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const { id } = await context.params;
  const dependencies = settingsDependencies();
  const repository = new SqliteSettingsRepository(getDatabase());
  return handleTestIndexer(id, request, {
    policy: dependencies.policy,
    findIndexer: (indexerId) => repository.listIndexers()
      .find((indexer) => indexer.id === indexerId) ?? null,
    clientFactory: (indexer) => new NewznabClient({
      id: indexer.id,
      name: indexer.name,
      baseUrl: indexer.baseUrl,
      apiKey: indexer.apiKey,
      timeoutMs: Math.min(indexer.timeoutMs, 10_000)
    }),
    recordResult: (indexerId, status) =>
      repository.recordIndexerTest(indexerId, status, Date.now())
  });
}
