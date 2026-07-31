/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppShell } from "@/components/app-shell";

describe("AppShell", () => {
  it("keeps every primary destination available with current-page state", () => {
    render(
      <AppShell pathname="/settings">
        <h1>Settings</h1>
      </AppShell>
    );

    const navigation = screen.getByRole("navigation", { name: "Primary" });
    expect(navigation).toBeVisible();
    expect(screen.getByRole("link", { name: "Discover" }))
      .toHaveAttribute("href", "/discover");
    expect(screen.getByRole("link", { name: "Library" }))
      .toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Activity" }))
      .toHaveAttribute("href", "/activity");
    expect(screen.getByRole("link", { name: "Settings" }))
      .toHaveAttribute("aria-current", "page");
  });
});
