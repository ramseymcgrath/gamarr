/**
 * How long after a game's first release anywhere a console release still
 * counts as that console's debut rather than a later port.
 *
 * IGDB timestamps are unix SECONDS, so this constant is in seconds.
 *
 * 365 days rather than the three or six months you might expect: Resident
 * Evil 4 reached the PS2 roughly nine months after the GameCube original and
 * is unambiguously a significant PS2 title, so a shorter window would cut it
 * on the merits. A year still drops Mafia (PC 2002, PS2 2004) and Age of
 * Empires II (PC 1999, PS2 2001), which are the cases this rule exists for.
 */
export const DEBUT_WINDOW_SECONDS = 365 * 24 * 60 * 60;

export interface DebutDates {
  firstReleaseDate: number | null;
  platformReleaseDate: number | null;
}

export function debutedOnPlatform(
  dates: DebutDates,
  windowSeconds: number = DEBUT_WINDOW_SECONDS
): boolean {
  const { firstReleaseDate, platformReleaseDate } = dates;
  // Absent metadata is not evidence of a late port, and hiding a real game
  // because IGDB lacks a date is the worse failure. Undecidable means keep.
  if (firstReleaseDate === null || platformReleaseDate === null) return true;
  return platformReleaseDate - firstReleaseDate <= windowSeconds;
}
