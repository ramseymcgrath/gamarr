/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { DiscoverScreen } from "@/features/catalog/discover-screen";

const platforms = [{
  id: 130,
  name: "Nintendo Switch",
  abbreviation: "Switch",
  visible: true,
  aliases: ["switch"],
  categoryIds: [],
  lastSyncedAt: 1
}];

describe("DiscoverScreen", () => {
  it("requires a platform before searching the catalog", async () => {
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    await user.type(screen.getByRole("searchbox"), "Metroid");

    expect(screen.getByRole("button", { name: "Search games" })).toBeDisabled();
  });
});
