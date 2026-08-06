import { existsSync, readFileSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Internet Archive downloads need neither an indexer nor SABnzbd: IGDB plus a
 * visible platform are the only setup. This spec intentionally runs before
 * setup-and-download.spec.ts (alphabetical, single worker) so its settings
 * writes stay idempotent and no duplicate indexer is created for the later
 * spec.
 */
test("downloads a selected Internet Archive file to disk", async ({ page }) => {
  await page.goto("/settings");

  const igdb = page.locator("#igdb");
  await igdb.getByLabel("Client ID").fill("fixture-client");
  await igdb.getByLabel("Client secret").fill("fixture-secret");
  await igdb.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByText("IGDB save complete")).toBeVisible();

  await page.getByRole("button", { name: "Refresh platforms" }).click();
  await expect(page.getByText("Platform refresh complete")).toBeVisible();
  await page.reload();
  await page.locator("#platforms").getByLabel("Nintendo Switch").check();

  await page.goto("/discover");
  await page.getByRole("button", { name: /Nintendo Switch/ }).click();
  await page.getByRole("searchbox").fill("Metroid");
  await page.getByRole("button", { name: "Search games" }).click();
  await page.getByRole("link", { name: /Metroid Prime 4: Beyond/ }).click();
  await page.getByRole("button", { name: "Search releases" }).click();

  await page.getByRole("button", { name: /Download Internet Archive/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Download from Internet Archive?")).toBeVisible();
  // The listing is largest-first, so the CHD is preselected; the user picks
  // the smaller ZIP instead.
  await expect(dialog.getByLabel(/\.chd/)).toBeChecked();
  await expect(dialog.getByText("Metadata")).toHaveCount(0);
  await dialog.getByLabel(/\.zip/).check();

  // Scan the open dialog once its entry animation has settled (see the
  // setup-and-download spec for why mid-animation contrast is unreliable).
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) =>
      animation.playState === "finished"));
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);

  await dialog.getByRole("button", { name: /Download file/ }).click();
  await expect(dialog.getByText("Download started")).toBeVisible();
  await page.getByRole("link", { name: "Open library" }).click();
  await expect(page.getByRole("link", { name: /Metroid Prime 4: Beyond/ }))
    .toBeVisible();

  await page.goto("/activity");
  await expect(async () => {
    await page.reload();
    const row = page.locator(".activity-row")
      .filter({ hasText: "Metroid.Prime.4.Beyond.(USA).zip" });
    await expect(row.getByText("Completed")).toBeVisible();
  }).toPass();

  const filePath = "test-results/e2e/downloads/"
    + "metroid-prime-4-beyond-usa/Metroid.Prime.4.Beyond.(USA).zip";
  expect(existsSync(filePath)).toBe(true);
  expect(readFileSync(filePath).toString("utf8"))
    .toBe("gamarr-fixture-rom-bytes");
});
