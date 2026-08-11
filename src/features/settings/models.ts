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

export const prowlarrSettingsInputSchema: z.ZodType<{
  baseUrl: string;
  apiKey: SecretUpdate;
  timeoutMs: number;
}> = z.object({
  baseUrl: z.url(),
  apiKey: secretUpdateSchema,
  timeoutMs: z.number().int().min(1_000).max(30_000)
});

export type ProwlarrSettingsInput =
  z.infer<typeof prowlarrSettingsInputSchema>;

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

export interface ProwlarrSettingsRecord {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  configRevision: number;
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

export interface PublicProwlarrSettings {
  baseUrl: string;
  hasApiKey: boolean;
  timeoutMs: number;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  configRevision: number;
}

export interface PublicSettings {
  igdb: PublicIgdbSettings | null;
  sabnzbd: PublicSabnzbdSettings | null;
  qbittorrent: PublicQbittorrentSettings | null;
  prowlarr: PublicProwlarrSettings | null;
}
