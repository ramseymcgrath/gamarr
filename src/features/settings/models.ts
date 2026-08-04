import { z } from "zod";

export const secretUpdateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retain") }),
  z.object({ action: z.literal("clear") }),
  z.object({
    action: z.literal("replace"),
    value: z.string().trim().min(1).max(4096)
  })
]);

export type SecretUpdate = z.infer<typeof secretUpdateSchema>;

export const igdbSettingsInputSchema = z.object({
  clientId: z.string().trim().min(1).max(255),
  clientSecret: secretUpdateSchema
});

export type IgdbSettingsInput = z.infer<typeof igdbSettingsInputSchema>;

export const sabnzbdSettingsInputSchema = z.object({
  baseUrl: z.url(),
  apiKey: secretUpdateSchema,
  defaultCategory: z.string().trim().max(255).nullable().default(null),
  maxNzbBytes: z.number().int().min(1024 * 1024).max(100 * 1024 * 1024)
});

export type SabnzbdSettingsInput = z.infer<typeof sabnzbdSettingsInputSchema>;

export const qbittorrentSettingsInputSchema = z.object({
  baseUrl: z.url(),
  username: z.string().trim().min(1).max(255),
  password: secretUpdateSchema,
  defaultCategory: z.string().trim().max(255).nullable().default(null)
});

export type QbittorrentSettingsInput =
  z.infer<typeof qbittorrentSettingsInputSchema>;

export const indexerInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(255),
  baseUrl: z.url(),
  apiKey: secretUpdateSchema,
  enabled: z.boolean(),
  categoryIds: z.array(z.string().trim().min(1).max(32)).max(100),
  timeoutMs: z.number().int().min(1_000).max(30_000)
});

export type IndexerInput = z.infer<typeof indexerInputSchema>;

export interface IgdbSettingsRecord {
  clientId: string;
  clientSecret: string;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  configRevision: number;
  updatedAt: number;
}

export interface SabnzbdSettingsRecord {
  baseUrl: string;
  apiKey: string;
  defaultCategory: string | null;
  maxNzbBytes: number;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  configRevision: number;
  updatedAt: number;
}

export interface QbittorrentSettingsRecord {
  baseUrl: string;
  username: string;
  password: string;
  defaultCategory: string | null;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  configRevision: number;
  updatedAt: number;
}

export interface IndexerRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  categoryIds: string[];
  timeoutMs: number;
  configRevision: number;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PublicIgdbSettings {
  clientId: string;
  hasClientSecret: boolean;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  configRevision: number;
}

export interface PublicSabnzbdSettings {
  baseUrl: string;
  hasApiKey: boolean;
  defaultCategory: string | null;
  maxNzbBytes: number;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  configRevision: number;
}

export interface PublicQbittorrentSettings {
  baseUrl: string;
  username: string;
  hasPassword: boolean;
  defaultCategory: string | null;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  configRevision: number;
}

export interface PublicIndexer {
  id: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  categoryIds: string[];
  timeoutMs: number;
  configRevision: number;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
}

export interface PublicSettings {
  igdb: PublicIgdbSettings | null;
  sabnzbd: PublicSabnzbdSettings | null;
  qbittorrent: PublicQbittorrentSettings | null;
  indexers: PublicIndexer[];
}
