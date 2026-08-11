/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsScreen } from "@/features/settings/settings-screen";

const initial = {
  igdb: null,
  sabnzbd: null,
  qbittorrent: null,
  prowlarr: {
    baseUrl: "http://prowlarr.local:9696",
    hasApiKey: true,
    timeoutMs: 10_000,
    lastTestStatus: "ok",
    lastTestedAt: 100,
    configRevision: 1
  }
};

describe("SettingsScreen", () => {
  it("renders the discovered indexer list after a successful test", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/settings/prowlarr") {
        return Response.json(initial);
      }
      if (String(input) === "/api/settings/prowlarr/test") {
        return Response.json({
          indexers: [
            { id: "1", name: "Torrent Tracker", protocol: "torrent", priority: 1 },
            { id: "2", name: "Usenet Indexer", protocol: "usenet", priority: 2 }
          ],
          torrent: 1,
          usenet: 1
        });
      }
      if (String(input) === "/api/settings") return Response.json(initial);
      throw new Error(`Unexpected request: ${String(input)}`);
    }));

    const { container } = render(<SettingsScreen initial={initial} />);
    fireEvent.click(within(container.querySelector("#prowlarr")!).getByRole(
      "button",
      { name: "Save and test" }
    ));

    expect(await screen.findByText("Torrent Tracker")).toBeVisible();
    expect(screen.getByText("torrent")).toBeVisible();
    expect(screen.getByText("priority 1")).toBeVisible();
    expect(screen.getByText("Usenet Indexer")).toBeVisible();
    expect(screen.getByText(/indexers are managed in Prowlarr/i)).toBeVisible();
  });

  it("never renders the prowlarr api key", () => {
    render(<SettingsScreen initial={initial} />);

    expect(screen.queryByDisplayValue("prowlarr-api-key")).not.toBeInTheDocument();
    expect(screen.queryByText("prowlarr-api-key")).not.toBeInTheDocument();
  });
});
