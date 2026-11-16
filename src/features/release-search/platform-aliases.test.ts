import { describe, expect, it } from "vitest";

import { platformAliases } from "@/features/release-search/platform-aliases";

describe("platformAliases", () => {
  it("gives common platforms aliases without any setup", () => {
    expect(platformAliases({ id: 8, aliases: [] }))
      .toEqual(["ps2", "playstation 2", "playstation2"]);
  });

  it("adds Settings aliases, lowercased and without repeats", () => {
    expect(platformAliases({ id: 5, aliases: [" WII ", "Nintendo Wii"] }))
      .toEqual(["wii", "nintendo wii"]);
  });

  it("uses only Settings aliases for platforms it doesn't know", () => {
    expect(platformAliases({ id: 999, aliases: ["thing"] })).toEqual(["thing"]);
  });
});
