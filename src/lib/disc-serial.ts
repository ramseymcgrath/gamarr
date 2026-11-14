/**
 * PlayStation disc serials (`SLUS-21447`, `SLES_123.45`, `SCUS 97101`).
 * Pure: normalization and extraction only.
 */

/** `SLUS_214.47`, `SLUS-21447`, `slus 21447` all normalize to `SLUS21447`. */
export function normalizeSerial(serial: string): string {
  return serial.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** `SLUS21447` → `SLUS-21447`, the form Redump and box art use. */
export function displaySerial(serial: string): string {
  const normalized = normalizeSerial(serial);
  const match = /^([A-Z]{4})(\d+)$/.exec(normalized);
  return match ? `${match[1]}-${match[2]}` : normalized;
}

/**
 * Serial-shaped tokens in a release title, normalized: four letters then five
 * digits, in the dash, underscore-and-dot (`SLUS_214.47`, the disc's boot
 * file) or bare forms. Shape alone proves nothing; callers keep only serials
 * a Redump list knows.
 */
export function extractSerials(text: string): string[] {
  const found = new Set<string>();
  const pattern = /(?<![A-Za-z0-9])([A-Za-z]{4})[-_ ]?(\d{3})[._ ]?(\d{2})(?![A-Za-z0-9])/g;
  for (const match of text.matchAll(pattern)) {
    found.add(`${match[1]!.toUpperCase()}${match[2]}${match[3]}`);
  }
  return [...found];
}
