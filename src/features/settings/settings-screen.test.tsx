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

  const switchPlatform = {
    id: 130,
    name: "Nintendo Switch",
    visible: true,
    aliases: ["Switch"],
    categoryIds: ["1000", "1080"],
    lastSyncedAt: 1
  };

  it("shows a visible platform's saved search categories", () => {
    render(<SettingsScreen initial={initial} platforms={[switchPlatform]} />);

    expect(screen.getByLabelText("Nintendo Switch search categories"))
      .toHaveValue("1000, 1080");
  });

  it("hides the category field for a platform that is not shown", () => {
    render(
      <SettingsScreen
        initial={initial}
        platforms={[{ ...switchPlatform, visible: false }]}
      />
    );

    expect(screen.queryByLabelText("Nintendo Switch search categories"))
      .not.toBeInTheDocument();
  });

  it("saves edited categories, split on commas and whitespace", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsScreen initial={initial} platforms={[switchPlatform]} />);
    const field = screen.getByLabelText("Nintendo Switch search categories");
    fireEvent.change(field, { target: { value: "1000, 1080 4050" } });
    fireEvent.blur(field);

    expect(fetchMock).toHaveBeenCalledWith("/api/platforms", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        id: 130,
        visible: true,
        aliases: ["Switch"],
        categoryIds: ["1000", "1080", "4050"]
      })
    }));
  });

  it("omits categoryIds when only visibility changes", () => {
    let sent: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (...args: unknown[]) => {
      sent = args[1] as RequestInit;
      return Response.json({ status: "ok" });
    }));

    render(<SettingsScreen initial={initial} platforms={[switchPlatform]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Nintendo Switch/ }));

    // A toggle must not rewrite categories: the handler leaves them alone
    // only when the field is absent entirely.
    const body = JSON.parse(sent?.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("categoryIds");
    expect(body.visible).toBe(false);
  });
});
