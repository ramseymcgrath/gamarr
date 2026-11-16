import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) =>
      animation.playState === "finished"));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

test("grabs one file out of a collection torrent without starting the rest", async ({
  page,
  request
}) => {
  expect(await request.get("http://127.0.0.1:4100/reset")).toBeOK();

  await page.goto("/settings");
  const igdb = page.locator("#igdb");
  await igdb.getByLabel("Client ID").fill("fixture-client");
  await igdb.getByLabel("Client secret").fill("fixture-secret");
  await igdb.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByText("IGDB save complete")).toBeVisible();

  await page.getByRole("button", { name: "Refresh platforms" }).click();
  await expect(page.getByText("Platform refresh complete")).toBeVisible();
  await page.reload();
  await page.locator("#platforms")
    .getByRole("checkbox", { name: /PlayStation 2/ })
    .check();

  const prowlarr = page.locator("#prowlarr");
  await prowlarr.getByLabel("Base URL").fill("http://prowlarr.test:9696");
  await prowlarr
    .getByRole("textbox", { name: /API key/ })
    .fill("fixture-prowlarr-key");
  await prowlarr.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByText("Prowlarr save complete")).toBeVisible();

  const qbittorrent = page.locator("#qbittorrent");
  await qbittorrent.getByLabel("Base URL")
    .fill("http://127.0.0.1:4100/qbittorrent");
  await qbittorrent.getByLabel("Username").fill("fixture-user");
  await qbittorrent.getByLabel("Password").fill("fixture-password");
  await qbittorrent.getByLabel("Default category").fill("games");
  await qbittorrent.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByText("qBittorrent save complete")).toBeVisible();

  await page.goto("/discover");
  await page.getByRole("button", { name: /PlayStation 2/ }).click();
  await page.getByRole("searchbox").fill("Fixture Quest");
  await page.getByRole("button", { name: "Search games" }).click();
  await page.getByRole("link", { name: /Fixture Quest/ }).click();
  await page.getByRole("button", { name: "Search releases" }).click();

  // Only the file whose title equals the game's is offered, not its siblings.
  const release = page.getByRole("button", { name: "Fixture Collection torrent" });
  await expect(release).toHaveCount(1);
  await expect(release).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await release.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Send to qBittorrent?" }))
    .toBeVisible();
  await expect(dialog.getByText(
    "Gamarr will turn on Fixture Quest (USA).iso in Fixture Collection"
  )).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await dialog.getByRole("button", { name: "Send to qBittorrent" }).click();
  await expect(dialog.getByText("Added to qBittorrent")).toBeVisible();

  // The torrent is added stopped, every file is switched off, only the
  // chosen one is raised, and start comes last. Start must never precede the
  // zeroing call.
  const calls = await (await request.get("http://127.0.0.1:4100/qbittorrent-calls"))
    .json() as string[];
  expect(calls).toEqual([
    "add:stopped",
    "filePrio:all:0",
    "filePrio:0:1",
    "start"
  ]);

  await page.goto("/activity");
  const row = page.locator(".activity-row")
    .filter({ hasText: "Fixture Quest" });
  await expect(row).toBeVisible();
  await expect(row.getByText("Fixture Collection (collection)")).toBeVisible();
  await expectNoAccessibilityViolations(page);
});
