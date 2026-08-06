import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("configures providers and sends a selected release to SABnzbd", async ({
  page
}) => {
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

  const indexers = page.locator("#indexers");
  await indexers.getByLabel("Name").fill("Fixture Indexer");
  await indexers.getByLabel("Newznab URL")
    .fill("http://127.0.0.1:4100/newznab/api");
  await indexers.getByLabel("API key").fill("indexer-secret");
  await indexers.getByLabel("Categories").fill("4050");
  await indexers.getByRole("button", { name: "Add and test indexer" }).click();
  await expect(page.getByText("Indexer save complete")).toBeVisible();

  const sab = page.locator("#sabnzbd");
  await sab.getByLabel("Base URL").fill("http://127.0.0.1:4100/sab");
  await sab.getByLabel("API key").fill("sab-secret");
  await sab.getByLabel("Default category").fill("games");
  await sab.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByText("SABnzbd save complete")).toBeVisible();

  await page.goto("/discover");
  await page.getByRole("button", { name: /Nintendo Switch/ }).click();
  await expect(page.getByRole("heading", { name: "Popular on Nintendo Switch" }))
    .toBeVisible();
  await expect(page.getByRole("link", { name: /Fixture Popular Classic/ }))
    .toBeVisible();

  // The axe scan at the end of this test runs on Library, and the 320px test
  // visits Discover with no platform selected, so neither one ever sees the
  // shelf. Scan it here, where it is on screen. Animations must settle first
  // for the same compositing reason documented at the later scan.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) =>
      animation.playState === "finished"));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("searchbox").fill("Metroid");
  await page.getByRole("button", { name: "Search games" }).click();
  await page.getByRole("link", { name: /Metroid Prime 4: Beyond/ }).click();
  await page.getByRole("button", { name: "Search releases" }).click();
  await page.getByRole("button", { name: /Send to SABnzbd/ }).click();
  await page.getByRole("dialog")
    .getByRole("button", { name: "Send to SABnzbd" })
    .click();
  await expect(page.getByText("Added to SABnzbd")).toBeVisible();
  await page.getByRole("link", { name: "Open library" }).click();
  await expect(page.getByRole("link", { name: /Metroid Prime 4: Beyond/ }))
    .toBeVisible();

  // Every route is wrapped in .page, which fades in via the page-enter
  // keyframes over 360ms. axe derives contrast from composited pixels, so
  // scanning mid-fade measures a partially transparent element: the primary
  // button was reported at roughly 44% opacity as #f6f7f2 on #8fa9d1 (2.2:1),
  // with the exact ratio drifting between runs, while the settled colours are
  // white on --blue #184fb3 at 7.48:1 — comfortably past AA and AAA.
  // Let animations settle so the scan measures the real design. Both keyframes
  // in globals.css are finite, so this cannot hang.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) =>
      animation.playState === "finished"));

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("reflows primary navigation at 320 pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/discover");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  const horizontalOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(horizontalOverflow).toBe(false);
});
