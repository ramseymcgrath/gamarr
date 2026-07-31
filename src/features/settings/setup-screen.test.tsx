/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SetupScreen } from "@/features/settings/setup-screen";

describe("SetupScreen", () => {
  it("derives resumable progress and points to the next incomplete step", () => {
    render(<SetupScreen readiness={{
      igdbReady: true,
      platformsReady: false,
      indexerReady: false,
      sabnzbdReady: true
    }} />);

    expect(screen.getByText("2 of 4 complete")).toBeVisible();
    expect(screen.getByRole("link", { name: "Continue with platforms" }))
      .toHaveAttribute("href", "/settings#platforms");
  });
});
