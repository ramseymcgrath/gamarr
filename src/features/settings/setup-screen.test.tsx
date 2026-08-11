/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SetupScreen } from "@/features/settings/setup-screen";

describe("SetupScreen", () => {
  it("derives resumable progress and points to the Prowlarr setup step", () => {
    render(<SetupScreen readiness={{
      igdbReady: true,
      platformsReady: true,
      indexerReady: false,
      sabnzbdReady: true
    }} />);

    expect(screen.getByText("3 of 4 complete")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Connect Prowlarr" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Continue with Prowlarr" }))
      .toHaveAttribute("href", "/settings#prowlarr");
  });
});
