import { describe, expect, it } from "vitest";

import {
  DEBUT_WINDOW_SECONDS,
  debutedOnPlatform
} from "@/features/catalog/debut-window";

const DAY = 24 * 60 * 60;
const FIRST = 1_000_000_000;

describe("debutedOnPlatform", () => {
  it("keeps a game released on the platform the day it launched anywhere", () => {
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST
    })).toBe(true);
  });

  it("keeps a port that arrived inside the window", () => {
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST + 200 * DAY
    })).toBe(true);
  });

  it("keeps a release exactly on the window boundary", () => {
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST + DEBUT_WINDOW_SECONDS
    })).toBe(true);
  });

  it("drops a port one second past the window", () => {
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST + DEBUT_WINDOW_SECONDS + 1
    })).toBe(false);
  });

  it("drops a port that arrived years later", () => {
    // Age of Empires II: PC 1999, PS2 2001.
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST + 730 * DAY
    })).toBe(false);
  });

  it("keeps a game with no first release date", () => {
    expect(debutedOnPlatform({
      firstReleaseDate: null,
      platformReleaseDate: FIRST
    })).toBe(true);
  });

  it("keeps a game with no dated release on the platform", () => {
    // Resident Evil 4 returned no PS2 release year from live IGDB and is
    // unambiguously a PS2 title. Undecidable must mean keep, not hide.
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: null
    })).toBe(true);
  });

  it("keeps a platform release dated before the first release", () => {
    // IGDB data is not always self-consistent; a negative gap is inside any
    // window and must not be treated as a late port.
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST - 30 * DAY
    })).toBe(true);
  });

  it("honours an explicit window override", () => {
    expect(debutedOnPlatform(
      { firstReleaseDate: FIRST, platformReleaseDate: FIRST + 10 * DAY },
      5 * DAY
    )).toBe(false);
  });

  it("uses a 365 day window by default", () => {
    expect(DEBUT_WINDOW_SECONDS).toBe(365 * 24 * 60 * 60);
  });
});
