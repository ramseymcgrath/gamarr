import { describe, expect, it } from "vitest";

import { byteLimitFromEnv } from "@/lib/env";

describe("byteLimitFromEnv", () => {
  const cases: Array<[string, string | undefined, number | undefined]> = [
    ["unset", undefined, undefined],
    ["empty", "", undefined],
    ["blank", "   ", undefined],
    ["zero", "0", undefined],
    ["negative", "-1", undefined],
    ["non-numeric", "abc", undefined],
    ["NaN", "NaN", undefined],
    ["Infinity", "Infinity", undefined],
    ["a byte count", "16777216", 16_777_216],
    ["a fractional value", "1.9", 1],
    // Below 1 the value clears a `> 0` test but floors to 0, and the caller's
    // `?? DEFAULT` cannot fall back on 0 — the ceiling would silently become
    // zero and reject every response on its first byte.
    ["a fraction below one", "0.5", undefined],
    ["a fraction just below one", "0.999", undefined]
  ];

  for (const [label, raw, expected] of cases) {
    it(`maps ${label} to ${String(expected)}`, () => {
      expect(byteLimitFromEnv(raw)).toBe(expected);
    });
  }
});
