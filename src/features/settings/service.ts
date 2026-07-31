import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

import type {
  IgdbSettingsInput,
  IgdbSettingsRecord,
  IndexerInput,
  IndexerRecord,
  PublicIndexer,
  PublicSettings,
  SabnzbdSettingsInput,
  SabnzbdSettingsRecord,
  SecretUpdate
} from "@/features/settings/models";
import {
  igdbSettingsInputSchema,
  indexerInputSchema,
  sabnzbdSettingsInputSchema
} from "@/features/settings/models";
import { validationError } from "@/lib/errors";

export interface SettingsRepository {
  getIgdb(): IgdbSettingsRecord | null;
  saveIgdb(value: IgdbSettingsRecord): void;
  getSabnzbd(): SabnzbdSettingsRecord | null;
  saveSabnzbd(value: SabnzbdSettingsRecord): void;
  listIndexers(): IndexerRecord[];
  saveIndexer(value: IndexerRecord): void;
  deleteIndexer(id: string, deletedAt: number): void;
}

function parseInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError) {
      throw validationError(error.issues[0]?.message ?? "Invalid settings", {
        cause: error
      });
    }
    throw error;
  }
}

function resolveSecret(update: SecretUpdate, existing?: string): string {
  switch (update.action) {
    case "replace":
      return update.value;
    case "clear":
      return "";
    case "retain":
      if (!existing) {
        throw validationError("A replacement secret is required");
      }
      return existing;
  }
}

function normalizeServiceUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw validationError("Service URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.hash) {
    throw validationError("Service URL cannot include credentials or fragments");
  }
  return url.toString().replace(/\/+$/, "");
}

export class SettingsService {
  constructor(
    private readonly repository: SettingsRepository,
    private readonly now: () => number = Date.now,
    private readonly id: () => string = randomUUID
  ) {}

  getRedacted(): PublicSettings {
    const igdb = this.repository.getIgdb();
    const sabnzbd = this.repository.getSabnzbd();
    return {
      igdb: igdb ? {
        clientId: igdb.clientId,
        hasClientSecret: igdb.clientSecret.length > 0,
        lastTestStatus: igdb.lastTestStatus,
        lastTestedAt: igdb.lastTestedAt,
        configRevision: igdb.configRevision
      } : null,
      sabnzbd: sabnzbd ? {
        baseUrl: sabnzbd.baseUrl,
        hasApiKey: sabnzbd.apiKey.length > 0,
        defaultCategory: sabnzbd.defaultCategory,
        maxNzbBytes: sabnzbd.maxNzbBytes,
        lastTestStatus: sabnzbd.lastTestStatus,
        lastTestedAt: sabnzbd.lastTestedAt,
        configRevision: sabnzbd.configRevision
      } : null,
      indexers: this.repository.listIndexers()
        .filter((item) => item.deletedAt === null)
        .map((item) => this.toPublicIndexer(item))
    };
  }

  saveIgdb(input: IgdbSettingsInput): void {
    const parsed = parseInput(() => igdbSettingsInputSchema.parse(input));
    const existing = this.repository.getIgdb();
    const clientSecret = resolveSecret(
      parsed.clientSecret,
      existing?.clientSecret
    );
    const changed =
      !existing ||
      existing.clientId !== parsed.clientId ||
      existing.clientSecret !== clientSecret;

    this.repository.saveIgdb({
      clientId: parsed.clientId,
      clientSecret,
      lastTestStatus: changed ? null : existing.lastTestStatus,
      lastTestedAt: changed ? null : existing.lastTestedAt,
      configRevision: changed ? (existing?.configRevision ?? 0) + 1 : existing.configRevision,
      updatedAt: this.now()
    });
  }

  saveSabnzbd(input: SabnzbdSettingsInput): void {
    const parsed = parseInput(() => sabnzbdSettingsInputSchema.parse(input));
    const existing = this.repository.getSabnzbd();
    const apiKey = resolveSecret(parsed.apiKey, existing?.apiKey);
    const baseUrl = normalizeServiceUrl(parsed.baseUrl);
    const changed =
      !existing ||
      existing.baseUrl !== baseUrl ||
      existing.apiKey !== apiKey ||
      existing.defaultCategory !== parsed.defaultCategory ||
      existing.maxNzbBytes !== parsed.maxNzbBytes;

    this.repository.saveSabnzbd({
      baseUrl,
      apiKey,
      defaultCategory: parsed.defaultCategory,
      maxNzbBytes: parsed.maxNzbBytes,
      lastTestStatus: changed ? null : existing.lastTestStatus,
      lastTestedAt: changed ? null : existing.lastTestedAt,
      configRevision: changed ? (existing?.configRevision ?? 0) + 1 : existing.configRevision,
      updatedAt: this.now()
    });
  }

  saveIndexer(input: IndexerInput): PublicIndexer {
    const parsed = parseInput(() => indexerInputSchema.parse(input));
    const existing = parsed.id
      ? this.repository.listIndexers().find((item) => item.id === parsed.id)
      : undefined;
    if (parsed.id && !existing) {
      throw validationError("Indexer does not exist");
    }

    const apiKey = resolveSecret(parsed.apiKey, existing?.apiKey);
    const baseUrl = normalizeServiceUrl(parsed.baseUrl);
    const changed =
      !existing ||
      existing.name !== parsed.name ||
      existing.baseUrl !== baseUrl ||
      existing.apiKey !== apiKey ||
      existing.enabled !== parsed.enabled ||
      JSON.stringify(existing.categoryIds) !== JSON.stringify(parsed.categoryIds) ||
      existing.timeoutMs !== parsed.timeoutMs;
    const timestamp = this.now();
    const record: IndexerRecord = {
      id: existing?.id ?? this.id(),
      name: parsed.name,
      baseUrl,
      apiKey,
      enabled: parsed.enabled,
      categoryIds: [...new Set(parsed.categoryIds)],
      timeoutMs: parsed.timeoutMs,
      configRevision: changed ? (existing?.configRevision ?? 0) + 1 : existing.configRevision,
      lastTestStatus: changed ? null : existing.lastTestStatus,
      lastTestedAt: changed ? null : existing.lastTestedAt,
      deletedAt: null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.repository.saveIndexer(record);
    return this.toPublicIndexer(record);
  }

  deleteIndexer(id: string): void {
    const existing = this.repository.listIndexers()
      .find((item) => item.id === id && item.deletedAt === null);
    if (!existing) {
      throw validationError("Indexer does not exist");
    }
    this.repository.deleteIndexer(id, this.now());
  }

  private toPublicIndexer(record: IndexerRecord): PublicIndexer {
    return {
      id: record.id,
      name: record.name,
      baseUrl: record.baseUrl,
      hasApiKey: record.apiKey.length > 0,
      enabled: record.enabled,
      categoryIds: record.categoryIds,
      timeoutMs: record.timeoutMs,
      configRevision: record.configRevision,
      lastTestStatus: record.lastTestStatus,
      lastTestedAt: record.lastTestedAt
    };
  }
}
