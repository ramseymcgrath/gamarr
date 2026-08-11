import { errorResponse } from "@/app/api/error-response";
import type {
  IgdbSettingsInput,
  ProwlarrSettingsInput,
  ProwlarrSettingsRecord,
  PublicSettings,
  QbittorrentSettingsInput,
  QbittorrentSettingsRecord,
  SabnzbdSettingsInput
} from "@/features/settings/models";
import { validationError } from "@/lib/errors";
import {
  assertTrustedMutation,
  type OriginPolicy
} from "@/lib/trusted-mutation";

interface SettingsHandlerService {
  getRedacted(): PublicSettings;
  saveIgdb(input: IgdbSettingsInput): void;
  saveSabnzbd(input: SabnzbdSettingsInput): void;
  saveQbittorrent(input: QbittorrentSettingsInput): void;
  saveProwlarr(input: ProwlarrSettingsInput): void;
}

interface ReadDependencies {
  service: SettingsHandlerService;
}

interface MutationDependencies extends ReadDependencies {
  policy: OriginPolicy;
}

interface DiscoveredIndexer {
  id: string;
  name: string;
  protocol: "usenet" | "torrent";
  priority: number;
}

interface ProwlarrTestClient {
  listIndexers(): Promise<DiscoveredIndexer[]>;
}

interface QbittorrentTestClient {
  testConnection(): Promise<void>;
}

export async function handleGetSettings(
  dependencies: ReadDependencies
): Promise<Response> {
  return Response.json(dependencies.service.getRedacted(), {
    headers: { "cache-control": "no-store" }
  });
}

export async function handlePutIgdb(
  request: Request,
  dependencies: MutationDependencies
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    dependencies.service.saveIgdb(await request.json() as IgdbSettingsInput);
    return Response.json(dependencies.service.getRedacted());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePutSabnzbd(
  request: Request,
  dependencies: MutationDependencies
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    dependencies.service.saveSabnzbd(
      await request.json() as SabnzbdSettingsInput
    );
    return Response.json(dependencies.service.getRedacted());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePutQbittorrent(
  request: Request,
  dependencies: MutationDependencies
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    dependencies.service.saveQbittorrent(
      await request.json() as QbittorrentSettingsInput
    );
    return Response.json(dependencies.service.getRedacted());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePutProwlarr(
  request: Request,
  dependencies: MutationDependencies
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    dependencies.service.saveProwlarr(
      await request.json() as ProwlarrSettingsInput
    );
    return Response.json(dependencies.service.getRedacted());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleTestProwlarr(
  request: Request,
  dependencies: {
    policy: OriginPolicy;
    getSettings: () => ProwlarrSettingsRecord | null;
    clientFactory: (settings: ProwlarrSettingsRecord) => ProwlarrTestClient;
    recordResult: (status: string) => void;
  }
): Promise<Response> {
  let trusted = false;
  try {
    assertTrustedMutation(request, dependencies.policy);
    trusted = true;
    const settings = dependencies.getSettings();
    if (!settings?.apiKey) throw validationError("Prowlarr is not configured");

    const discovered = await dependencies.clientFactory(settings).listIndexers();
    const indexers = discovered.map(({ id, name, protocol, priority }) => ({
      id,
      name,
      protocol,
      priority
    }));
    dependencies.recordResult("ok");
    return Response.json({
      indexers,
      usenet: indexers.filter((indexer) => indexer.protocol === "usenet").length,
      torrent: indexers.filter((indexer) => indexer.protocol === "torrent").length
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (trusted) dependencies.recordResult("failed");
    return errorResponse(error, {
      code: "UNAVAILABLE",
      message: "Prowlarr connection failed",
      status: 502
    });
  }
}

export async function handleTestQbittorrent(
  request: Request,
  dependencies: {
    policy: OriginPolicy;
    getSettings: () => QbittorrentSettingsRecord | null;
    clientFactory: (
      settings: QbittorrentSettingsRecord
    ) => QbittorrentTestClient;
    recordResult: (status: string) => void;
  }
): Promise<Response> {
  let trusted = false;
  try {
    assertTrustedMutation(request, dependencies.policy);
    trusted = true;
    const settings = dependencies.getSettings();
    if (!settings?.password) {
      throw validationError("qBittorrent is not configured");
    }
    await dependencies.clientFactory(settings).testConnection();
    dependencies.recordResult("ok");
    return Response.json({ status: "ok" });
  } catch (error) {
    if (trusted) dependencies.recordResult("failed");
    return errorResponse(error, {
      code: "UNAVAILABLE",
      message: "qBittorrent connection failed",
      status: 502
    });
  }
}
