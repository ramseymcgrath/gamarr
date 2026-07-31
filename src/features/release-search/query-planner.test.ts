import { describe, expect, it } from "vitest";

import { planQueries } from "@/features/release-search/query-planner";

describe("planQueries", () => {
  it("builds deterministic canonical and alternate platform queries", () => {
    expect(planQueries({
      title: "The Legend of Zelda: Tears of the Kingdom",
      alternativeNames: ["Zelda TotK"],
      releaseYear: 2023,
      titleIsAmbiguous: false,
      platformAliases: ["Switch", "NSW"],
      categoryIds: ["4050"]
    })).toEqual([
      {
        term: "The Legend of Zelda Tears of the Kingdom Switch",
        categories: ["4050"],
        reason: "canonical-platform"
      },
      {
        term: "The Legend of Zelda Tears of the Kingdom NSW",
        categories: ["4050"],
        reason: "canonical-platform"
      },
      {
        term: "Zelda TotK Switch",
        categories: ["4050"],
        reason: "alternate-platform"
      },
      {
        term: "Zelda TotK NSW",
        categories: ["4050"],
        reason: "alternate-platform"
      }
    ]);
  });

  it("caps query variants at eight and includes year only for ambiguous titles", () => {
    const queries = planQueries({
      title: "Game",
      alternativeNames: ["Alt One", "Alt Two", "Alt Three"],
      releaseYear: 2026,
      titleIsAmbiguous: true,
      platformAliases: ["A", "B", "C", "D"],
      categoryIds: []
    });

    expect(queries).toHaveLength(8);
    expect(queries.every((query) => query.term.includes("2026"))).toBe(true);
  });
});
