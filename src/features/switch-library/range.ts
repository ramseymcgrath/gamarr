/**
 * Pure parsing of a single-range HTTP `Range` header. No I/O.
 *
 * Multi-range is unsupported on purpose: DBI never sends it, and honoring it
 * would mean multipart/byteranges for no benefit. Per RFC 9110 an
 * unrecognized range is ignored rather than rejected, so anything that does
 * not parse yields the full representation.
 */

export type RangeResult =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

const singleRange = /^bytes=(\d*)-(\d*)$/;

export function parseRangeHeader(
  header: string | null,
  sizeBytes: number
): RangeResult {
  if (header === null) return { kind: "full" };
  const match = singleRange.exec(header.trim());
  if (!match) return { kind: "full" };

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { kind: "full" };
  if (sizeBytes === 0) return { kind: "unsatisfiable" };

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return { kind: "unsatisfiable" };
    return {
      kind: "partial",
      start: Math.max(0, sizeBytes - suffix),
      end: sizeBytes - 1
    };
  }

  const start = Number(rawStart);
  if (start >= sizeBytes) return { kind: "unsatisfiable" };
  const end = rawEnd === "" ? sizeBytes - 1 : Math.min(Number(rawEnd), sizeBytes - 1);
  if (end < start) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end };
}
