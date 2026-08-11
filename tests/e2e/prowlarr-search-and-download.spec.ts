import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const prowlarrApiKey = "fixture-prowlarr-key";

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) =>
      animation.playState === "finished"));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

test("searches Prowlarr and sends a torrent release to qBittorrent", async ({
  page,
  request
}) => {
  const reset = await request.get("http://127.0.0.1:4100/reset");
  expect(reset).toBeOK();

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

  const prowlarr = page.locator("#prowlarr");
  await prowlarr.getByLabel("Base URL").fill("http://prowlarr.test:9696");
  // By role, not label: once a key is saved the card also renders a
  // "Clear saved API key" checkbox, and getByLabel matches both.
  await prowlarr
    .getByRole("textbox", { name: /API key/ })
    .fill(prowlarrApiKey);
  await prowlarr.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByText("Prowlarr save complete")).toBeVisible();
  await expect(prowlarr.getByText("Fixture Torrent")).toBeVisible();
  await expect(prowlarr.getByText("Fixture Usenet")).toBeVisible();
  await expect(prowlarr.getByText("torrent", { exact: true })).toBeVisible();
  await expect(prowlarr.getByText("usenet", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(prowlarrApiKey);

  const qbittorrent = page.locator("#qbittorrent");
  await qbittorrent.getByLabel("Base URL")
    .fill("http://127.0.0.1:4100/qbittorrent");
  await qbittorrent.getByLabel("Username").fill("fixture-user");
  await qbittorrent.getByLabel("Password").fill("fixture-password");
  await qbittorrent.getByLabel("Default category").fill("games");
  await qbittorrent.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByText("qBittorrent save complete")).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await page.goto("/discover");
  await page.getByRole("button", { name: /Nintendo Switch/ }).click();
  await page.getByRole("searchbox").fill("Metroid");
  await page.getByRole("button", { name: "Search games" }).click();
  await expect(page.getByRole("link", { name: /Metroid Prime 4: Beyond/ }))
    .toBeVisible();
  await expectNoAccessibilityViolations(page);

  await page.getByRole("link", { name: /Metroid Prime 4: Beyond/ }).click();
  await page.getByRole("button", { name: "Search releases" }).click();
  await expect(page.getByRole("button", { name: "Fixture Torrent torrent" }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Fixture Usenet usenet" }))
    .toBeVisible();
  await expect(page.getByText("42 seeders")).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await page.getByRole("button", { name: "Fixture Torrent torrent" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Send to qBittorrent?" }))
    .toBeVisible();
  await expect(dialog.getByLabel("Metroid.Prime.4.Beyond.NSW-GAMARR.nsp"))
    .toBeVisible();
  await expectNoAccessibilityViolations(page);

  await dialog.getByRole("button", { name: "Send to qBittorrent" }).click();
  await expect(dialog.getByText("Added to qBittorrent")).toBeVisible();

  await page.goto("/activity");
  const row = page.locator(".activity-row")
    .filter({ hasText: "Metroid.Prime.4.Beyond.NSW-GAMARR" });
  await expect(row).toBeVisible();
  await expect(row.getByText("Queued")).toBeVisible();
  await expect(row.getByText("Pending")).toHaveCount(0);

  await page.getByRole("button", { name: "Refresh active" }).click();
  await expect(row.getByText("Downloading")).toBeVisible();
  await expectNoAccessibilityViolations(page);
});
