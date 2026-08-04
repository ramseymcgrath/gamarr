/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsScreen } from "@/features/settings/settings-screen";

describe("SettingsScreen", () => {
  it("shows saved-secret state without rendering saved credentials", () => {
    render(<SettingsScreen initial={{
      igdb: {
        clientId: "client",
        hasClientSecret: true,
        lastTestStatus: "ok",
        lastTestedAt: 100,
        configRevision: 1
      },
      sabnzbd: {
        baseUrl: "http://sab.local",
        hasApiKey: true,
        defaultCategory: "games",
        maxNzbBytes: 20 * 1024 * 1024,
        lastTestStatus: null,
        lastTestedAt: null,
        configRevision: 1
      },
      qbittorrent: null,
      indexers: []
    }} />);

    expect(screen.getAllByText("Credential saved").length).toBeGreaterThan(0);
    expect(screen.queryByDisplayValue("secret")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Twitch Developer Portal" }))
      .toHaveAttribute("target", "_blank");
  });
});
