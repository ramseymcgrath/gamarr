import { AppError } from "@/lib/errors";

/** Generous for a magnet with many trackers, tight enough to bound parsing. */
const maxMagnetLength = 4096;
const hexInfoHash = /^[0-9a-fA-F]{40}$/;
const base32InfoHash = /^[A-Z2-7]{32}$/i;
const btihPrefix = "urn:btih:";

export type MagnetRejectionReason =
  | "malformed"
  | "unsupportedScheme"
  | "missingInfoHash"
  | "unsupportedTopic"
  | "tooLong"
  | "credentialExposed";

/**
 * A per-release rejection, shaped like `DownloadUrlPolicyError`. The offending
 * URI is deliberately never stored on the error: a redirect can echo the
 * Prowlarr API key into it, and these messages reach user-facing warnings.
 */
export class MagnetPolicyError extends AppError {
  constructor(
    readonly reason: MagnetRejectionReason,
    message: string
  ) {
    super("VALIDATION", 400, message);
    this.name = "MagnetPolicyError";
  }
}

/**
 * Decoded once so a percent-encoded credential is caught too. Decoding can
 * throw on malformed escapes, which is itself a rejection.
 */
function decodedForms(uri: string): string[] {
  const forms = [uri];
  try {
    forms.push(decodeURIComponent(uri));
  } catch {
    throw new MagnetPolicyError("malformed", "Magnet URI is malformed");
  }
  return forms;
}

export function validateMagnet(uri: string, apiKey: string): string {
  if (uri.length > maxMagnetLength) {
    throw new MagnetPolicyError("tooLong", "Magnet URI is too long");
  }

  const forms = decodedForms(uri);

  let target: URL;
  try {
    target = new URL(uri);
  } catch {
    throw new MagnetPolicyError("malformed", "Magnet URI is malformed");
  }

  if (target.protocol !== "magnet:") {
    throw new MagnetPolicyError(
      "unsupportedScheme",
      "Torrent link must use the magnet scheme"
    );
  }

  const topics = target.searchParams.getAll("xt");
  if (topics.some((topic) => !topic.startsWith(btihPrefix))) {
    throw new MagnetPolicyError(
      "unsupportedTopic",
      "Magnet URI declares an unsupported topic type"
    );
  }

  const hashes = topics.map((topic) => topic.slice(btihPrefix.length));
  const usable = hashes.some((hash) =>
    hexInfoHash.test(hash) || base32InfoHash.test(hash));
  if (!usable) {
    throw new MagnetPolicyError(
      "missingInfoHash",
      "Magnet URI carries no usable BitTorrent info hash"
    );
  }

  // Checked last so a redirect that smuggles the key into an otherwise valid
  // magnet is still caught, and checked against both raw and decoded forms.
  if (apiKey.length > 0 && forms.some((form) => form.includes(apiKey))) {
    throw new MagnetPolicyError(
      "credentialExposed",
      "Torrent link exposed the configured Prowlarr credential"
    );
  }

  return uri;
}
