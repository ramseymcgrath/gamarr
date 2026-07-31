const baseUrl = process.env.GAMARR_VERIFY_URL ?? "http://127.0.0.1:3200";
const providerUrl = process.env.GAMARR_VERIFY_PROVIDER_URL ??
  "http://127.0.0.1:4100";

async function request(path, method = "GET", body) {
  const headers = new Headers();
  if (method !== "GET") headers.set("origin", baseUrl);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

await request("/api/settings/igdb", "PUT", {
  clientId: "fixture-client",
  clientSecret: { action: "replace", value: "fixture-secret" }
});
await request("/api/settings/igdb/test", "POST");
await request("/api/platforms/sync", "POST");
const platforms = await request("/api/platforms");
const platform = platforms.find((value) => value.name === "Nintendo Switch");
if (!platform) throw new Error("Fixture platform was not synchronized");
await request("/api/platforms", "PUT", {
  id: platform.id,
  visible: true,
  aliases: ["switch", "nsw"]
});
const indexer = await request("/api/settings/indexers", "POST", {
  name: "Fixture Indexer",
  baseUrl: `${providerUrl}/newznab/api`,
  apiKey: { action: "replace", value: "indexer-secret" },
  enabled: true,
  categoryIds: ["4050"],
  timeoutMs: 10_000
});
await request(`/api/settings/indexers/${indexer.id}/test`, "POST");
await request("/api/settings/sabnzbd", "PUT", {
  baseUrl: `${providerUrl}/sab`,
  apiKey: { action: "replace", value: "sab-secret" },
  defaultCategory: "games",
  maxNzbBytes: 20 * 1024 * 1024
});
await request("/api/settings/sabnzbd/test", "POST");
const games = await request(
  `/api/catalog/search?query=Metroid&platformId=${platform.id}`
);
if (games.length !== 1) throw new Error("Fixture catalog search did not match");
const releases = await request("/api/releases/search", "POST", {
  gameId: games[0].id,
  platformId: platform.id
});
if (
  releases.releases.length !== 1 ||
  JSON.stringify(releases).includes("indexer-secret") ||
  JSON.stringify(releases).includes(providerUrl)
) {
  throw new Error("Release response was empty or leaked provider details");
}
const attempt = await request("/api/downloads", "POST", {
  submissionKey: `fixture-submission-${crypto.randomUUID()}`,
  candidateId: releases.releases[0].sources[0].candidateId,
  gameId: games[0].id,
  platformId: platform.id
});
if (attempt.status !== "Queued") {
  throw new Error(`Expected Queued attempt, received ${attempt.status}`);
}
const library = await request("/api/library");
if (library.length !== 1 || library[0].gameTitle !== games[0].name) {
  throw new Error("Downloaded game was not retained in the library");
}

process.stdout.write("Gamarr API flow verified: catalog -> release -> SABnzbd -> library\n");
