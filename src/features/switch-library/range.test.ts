import { describe, expect, it } from "vitest";

import { parseRangeHeader } from "@/features/switch-library/range";

describe("parseRangeHeader", () => {
  it("treats a missing header as the whole file", () => {
    expect(parseRangeHeader(null, 100)).toEqual({ kind: "full" });
  });

  it("parses a closed range", () => {
    expect(parseRangeHeader("bytes=0-99", 1000))
      .toEqual({ kind: "partial", start: 0, end: 99 });
  });

  it("parses an open-ended range as running to the last byte", () => {
    // This is the resume case: DBI reconnects asking for everything from
    // where it stopped. It must work or a dropped transfer restarts at zero.
    expect(parseRangeHeader("bytes=500-", 1000))
      .toEqual({ kind: "partial", start: 500, end: 999 });
  });

  it("clamps an end past the last byte", () => {
    expect(parseRangeHeader("bytes=0-99999", 1000))
      .toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("parses a suffix range as the trailing bytes", () => {
    expect(parseRangeHeader("bytes=-200", 1000))
      .toEqual({ kind: "partial", start: 800, end: 999 });
  });

  it("clamps an oversized suffix range to the whole file", () => {
    expect(parseRangeHeader("bytes=-99999", 1000))
      .toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("reports a start at or past the end as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=1500-1600", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("reports a backwards range as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=500-100", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("reports a zero-length suffix as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("ignores a malformed or multi-range header rather than failing", () => {
    // RFC 9110: an unparseable Range is ignored and the full representation
    // is returned. Multi-range is deliberately unsupported.
    expect(parseRangeHeader("bytes=0-1,5-6", 1000)).toEqual({ kind: "full" });
    expect(parseRangeHeader("items=0-1", 1000)).toEqual({ kind: "full" });
    expect(parseRangeHeader("garbage", 1000)).toEqual({ kind: "full" });
    expect(parseRangeHeader("bytes=-", 1000)).toEqual({ kind: "full" });
  });

  it("reports any range against an empty file as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
  });
});
