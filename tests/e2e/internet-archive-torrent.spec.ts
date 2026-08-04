import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("sends an Internet Archive item to qBittorrent and reconciles it", async ({
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

  const qbittorrent = page.locator("#qbittorrent");
  await qbittorrent.getByLabel("Base URL")
    .fill("http://127.0.0.1:4100/qbittorrent");
  await qbittorrent.getByLabel("Username").fill("fixture-user");
  await qbittorrent.getByLabel("Password").fill("fixture-password");
  await qbittorrent.getByLabel("Default category").fill("games");
  await qbittorrent.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByText("qBittorrent save complete")).toBeVisible();

  await page.goto("/discover");
  await page.getByRole("button", { name: /Nintendo Switch/ }).click();
  await page.getByRole("searchbox").fill("Metroid");
  await page.getByRole("button", { name: "Search games" }).click();
  await page.getByRole("link", { name: /Metroid Prime 4: Beyond/ }).click();
  await page.getByRole("button", { name: "Search releases" }).click();

  await page.getByRole("button", { name: /Download Internet Archive/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Download from Internet Archive?")).toBeVisible();
  await expect(dialog.locator("fieldset label").first())
    .toContainText("Entire item (torrent)");
  const torrentOption = dialog.getByLabel("Entire item (torrent)");
  await expect(torrentOption).toBeEnabled();
  await torrentOption.check();

  await page.waitForFunction(() =>
    document.getAnimations().every((animation) =>
      animation.playState === "finished"));
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);

  await dialog.getByRole("button", { name: "Send to qBittorrent" }).click();
  await expect(dialog.getByText("Added to qBittorrent")).toBeVisible();

  await page.goto("/activity");
  const row = page.locator(".activity-row")
    .filter({ hasText: "Internet Archive (torrent)" });
  await expect(row.getByText("Queued")).toBeVisible();

  await page.getByRole("button", { name: "Refresh active" }).click();
  await expect(row.getByText("Downloading")).toBeVisible();
  await page.getByRole("button", { name: "Refresh active" }).click();
  await expect(row.getByText("Completed")).toBeVisible();
});
