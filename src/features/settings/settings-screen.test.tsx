/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

  it("retains a saved qBittorrent password while saving and testing its settings", async () => {
    const initial = {
      igdb: null,
      sabnzbd: null,
      qbittorrent: {
        baseUrl: "http://qbittorrent.local:8080",
        username: "gamarr",
        hasPassword: true,
        defaultCategory: "retro-games",
        lastTestStatus: null,
        lastTestedAt: null,
        configRevision: 1
      },
      indexers: []
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(initial)));

    const { container } = render(<SettingsScreen initial={initial} />);
    const card = within(container.querySelector("#qbittorrent")!);

    expect(card.getByDisplayValue("http://qbittorrent.local:8080")).toBeInTheDocument();
    expect(card.getByDisplayValue("gamarr")).toBeInTheDocument();
    const password = card.getByPlaceholderText("Leave blank to retain");
    expect(password).toHaveValue("");
    expect(card.getByText("Password").tagName).toBe("LABEL");

    fireEvent.change(card.getByDisplayValue("retro-games"), {
      target: { value: "" }
    });
    fireEvent.click(card.getByRole("button", { name: "Save and test" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("qBittorrent save complete");
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/settings/qbittorrent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://qbittorrent.local:8080",
        username: "gamarr",
        password: { action: "retain" },
        defaultCategory: null
      })
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/settings/qbittorrent/test",
      expect.objectContaining({ method: "POST" })
    );
  });
});
