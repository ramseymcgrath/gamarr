/**
 * How release titles name the common platforms, keyed by IGDB platform id.
 * Merged with the aliases set in Settings, so ranking can tell a PS2 upload
 * from a Wii or Xbox 360 one without any setup.
 *
 * Kept to names that mean the platform in a release title. Bare words that
 * also mean something else ("playstation" alone, "dc", "pc" inside "pcsx2")
 * are left out; a short alias that is part of a longer one ("wii" in
 * "wii u") is handled by the matcher.
 */
const BUILT_IN_ALIASES: ReadonlyMap<number, readonly string[]> = new Map([
  [3, ["linux"]],
  [4, ["n64", "nintendo 64"]],
  [5, ["wii"]],
  [6, ["pc", "windows", "win64", "win32"]],
  [7, ["ps1", "psx", "psone", "playstation 1"]],
  [8, ["ps2", "playstation 2", "playstation2"]],
  [9, ["ps3", "playstation 3", "playstation3"]],
  [11, ["xbox"]],
  [12, ["xbox 360", "xbox360", "x360"]],
  [14, ["macos", "mac os", "osx"]],
  [18, ["nes"]],
  [19, ["snes", "super nintendo", "super famicom"]],
  [20, ["nds", "nintendo ds"]],
  [21, ["gamecube", "ngc", "gcn"]],
  [22, ["gbc", "game boy color"]],
  [23, ["dreamcast"]],
  [24, ["gba", "game boy advance"]],
  [29, ["genesis", "mega drive", "megadrive"]],
  [32, ["sega saturn"]],
  [33, ["game boy"]],
  [34, ["android"]],
  [37, ["3ds", "nintendo 3ds"]],
  [38, ["psp", "playstation portable"]],
  [39, ["ios"]],
  [41, ["wii u", "wiiu"]],
  [46, ["ps vita", "psvita", "playstation vita"]],
  [48, ["ps4", "playstation 4", "playstation4"]],
  [49, ["xbox one", "xboxone"]],
  [130, ["nsw", "nintendo switch"]],
  [167, ["ps5", "playstation 5", "playstation5"]],
  [169, ["xbox series x", "xbox series s", "xbox series"]],
  [508, ["switch 2", "nintendo switch 2"]]
]);

/** Built-in aliases plus the ones set in Settings, lowercased, no repeats. */
export function platformAliases(platform: { id: number; aliases: string[] }): string[] {
  return [...new Set([
    ...(BUILT_IN_ALIASES.get(platform.id) ?? []),
    ...platform.aliases
  ].map((alias) => alias.trim().toLowerCase()).filter(Boolean))];
}
