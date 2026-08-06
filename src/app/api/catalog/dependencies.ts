import "server-only";

import { getDatabase } from "@/db/client";
import { InFlightRefreshCoordinator } from "@/features/catalog/refresh-coordinator";
import { SqliteCatalogRepository } from "@/features/catalog/repository";
import { SqliteLibraryRepository } from "@/features/library/repository";
import { CatalogService } from "@/features/catalog/service";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { validationError } from "@/lib/errors";
import { IgdbClient, SdkIgdbExecutor } from "@/integrations/igdb/client";
import { IgdbRequestGate } from "@/integrations/igdb/request-gate";
import { TwitchTokenManager } from "@/integrations/igdb/token-manager";

let cached:
  | {
      revision: number;
      clientId: string;
      client: IgdbClient;
    }
  | undefined;
const gate = new IgdbRequestGate();
// Module-scoped for the same reason `gate` is: `catalogService()` builds a new
// service per request, so a per-instance coordinator would never dedupe.
const popularRefreshes = new InFlightRefreshCoordinator();

function igdbClient(): IgdbClient {
  const settings = new SqliteSettingsRepository(getDatabase()).getIgdb();
  if (!settings?.clientId || !settings.clientSecret) {
    throw validationError("IGDB credentials are not configured");
  }
  if (
    cached &&
    cached.revision === settings.configRevision &&
    cached.clientId === settings.clientId
  ) {
    return cached.client;
  }

  const e2e = process.env.GAMARR_E2E === "true";
  const tokens = new TwitchTokenManager({
    credentials: () => ({
      clientId: settings.clientId,
      clientSecret: settings.clientSecret
    }),
    tokenEndpoint: e2e ? process.env.GAMARR_TWITCH_TOKEN_URL : undefined
  });
  const client = new IgdbClient(
    tokens,
    new SdkIgdbExecutor({
      clientId: settings.clientId,
      baseUrl: e2e ? process.env.GAMARR_IGDB_BASE_URL : undefined
    }),
    { gate: () => gate.wait() }
  );
  cached = {
    revision: settings.configRevision,
    clientId: settings.clientId,
    client
  };
  return client;
}

export function catalogService(): CatalogService {
  return new CatalogService(
    new SqliteCatalogRepository(getDatabase()),
    igdbClient,
    Date.now,
    popularRefreshes,
    new SqliteLibraryRepository(getDatabase())
  );
}
