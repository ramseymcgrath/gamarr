import { ZodError } from "zod";

import type {
  IgdbSettingsInput,
  IgdbSettingsRecord,
  ProwlarrSettingsInput,
  ProwlarrSettingsRecord,
  PublicSettings,
  QbittorrentSettingsInput,
  QbittorrentSettingsRecord,
  SabnzbdSettingsInput,
  SabnzbdSettingsRecord,
  SecretUpdate
} from "@/features/settings/models";
import {
  igdbSettingsInputSchema,
  prowlarrSettingsInputSchema,
  qbittorrentSettingsInputSchema,
  sabnzbdSettingsInputSchema
} from "@/features/settings/models";
import { validationError } from "@/lib/errors";

export interface SettingsRepository {
  getIgdb(): IgdbSettingsRecord | null;
  saveIgdb(value: IgdbSettingsRecord): void;
  getSabnzbd(): SabnzbdSettingsRecord | null;
  saveSabnzbd(value: SabnzbdSettingsRecord): void;
  getQbittorrent(): QbittorrentSettingsRecord | null;
  saveQbittorrent(value: QbittorrentSettingsRecord): void;
  recordQbittorrentTest(status: string, testedAt: number): void;
  getProwlarr(): ProwlarrSettingsRecord | null;
  saveProwlarr(value: ProwlarrSettingsRecord): void;
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
    private readonly now: () => number = Date.now
  ) {}

  getRedacted(): PublicSettings {
    const igdb = this.repository.getIgdb();
    const sabnzbd = this.repository.getSabnzbd();
    const qbittorrent = this.repository.getQbittorrent();
    const prowlarr = this.repository.getProwlarr();
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
      qbittorrent: qbittorrent ? {
        baseUrl: qbittorrent.baseUrl,
        username: qbittorrent.username,
        hasPassword: qbittorrent.password.length > 0,
        defaultCategory: qbittorrent.defaultCategory,
        lastTestStatus: qbittorrent.lastTestStatus,
        lastTestedAt: qbittorrent.lastTestedAt,
        configRevision: qbittorrent.configRevision
      } : null,
      prowlarr: prowlarr ? {
        baseUrl: prowlarr.baseUrl,
        hasApiKey: prowlarr.apiKey.length > 0,
        timeoutMs: prowlarr.timeoutMs,
        lastTestStatus: prowlarr.lastTestStatus,
        lastTestedAt: prowlarr.lastTestedAt,
        configRevision: prowlarr.configRevision
      } : null
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

  saveQbittorrent(input: QbittorrentSettingsInput): void {
    const parsed = parseInput(() => qbittorrentSettingsInputSchema.parse(input));
    const existing = this.repository.getQbittorrent();
    const password = resolveSecret(parsed.password, existing?.password);
    const baseUrl = normalizeServiceUrl(parsed.baseUrl);
    const changed =
      !existing ||
      existing.baseUrl !== baseUrl ||
      existing.username !== parsed.username ||
      existing.password !== password ||
      existing.defaultCategory !== parsed.defaultCategory;

    this.repository.saveQbittorrent({
      baseUrl,
      username: parsed.username,
      password,
      defaultCategory: parsed.defaultCategory,
      lastTestStatus: changed ? null : existing.lastTestStatus,
      lastTestedAt: changed ? null : existing.lastTestedAt,
      configRevision: changed ? (existing?.configRevision ?? 0) + 1 : existing.configRevision,
      updatedAt: this.now()
    });
  }

  saveProwlarr(input: ProwlarrSettingsInput): void {
    const parsed = parseInput(() => prowlarrSettingsInputSchema.parse(input));
    const existing = this.repository.getProwlarr();
    const apiKey = resolveSecret(parsed.apiKey, existing?.apiKey);
    const baseUrl = normalizeServiceUrl(parsed.baseUrl);
    const changed =
      !existing ||
      existing.baseUrl !== baseUrl ||
      existing.apiKey !== apiKey ||
      existing.timeoutMs !== parsed.timeoutMs;

    this.repository.saveProwlarr({
      baseUrl,
      apiKey,
      timeoutMs: parsed.timeoutMs,
      lastTestStatus: changed ? null : existing.lastTestStatus,
      lastTestedAt: changed ? null : existing.lastTestedAt,
      configRevision: changed
        ? (existing?.configRevision ?? 0) + 1
        : existing.configRevision,
      updatedAt: this.now()
    });
  }
}
