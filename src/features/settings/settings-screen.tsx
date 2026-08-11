"use client";

import {
  ExternalLink,
  RefreshCw,
  Save,
  TestTube2
} from "lucide-react";
import {
  useState,
  type FormEvent
} from "react";

import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { PlatformView } from "@/features/catalog/models";
import type { PublicSettings } from "@/features/settings/models";

async function mutate(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: body === undefined
      ? undefined
      : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Request failed");
  }
  return payload;
}

function CredentialState({ saved }: { saved: boolean }) {
  return (
    <span className="credential-state">
      {saved ? "Credential saved" : "Credential required"}
    </span>
  );
}

export function SettingsScreen({
  initial,
  platforms = []
}: {
  initial: PublicSettings;
  platforms?: PlatformView[];
}) {
  const [settings, setSettings] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [igdbSecret, setIgdbSecret] = useState("");
  const [sabKey, setSabKey] = useState("");
  const [qbPassword, setQbPassword] = useState("");
  const [prowlarrKey, setProwlarrKey] = useState("");
  const [clearProwlarrKey, setClearProwlarrKey] = useState(false);
  const [discoveredIndexers, setDiscoveredIndexers] = useState<Array<{
    id: string;
    name: string;
    protocol: "usenet" | "torrent";
    priority: number;
  }>>([]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setMessage(null);
    try {
      await action();
      const next = await fetch("/api/settings", { cache: "no-store" });
      if (next.ok) setSettings(await next.json());
      setMessage(`${label} complete`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  const saveIgdb = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run("IGDB save", async () => {
      await mutate("/api/settings/igdb", "PUT", {
        clientId: form.get("clientId"),
        clientSecret: igdbSecret
          ? { action: "replace", value: igdbSecret }
          : { action: "retain" }
      });
      await mutate("/api/settings/igdb/test", "POST");
      setIgdbSecret("");
    });
  };

  const saveSab = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run("SABnzbd save", async () => {
      await mutate("/api/settings/sabnzbd", "PUT", {
        baseUrl: form.get("baseUrl"),
        apiKey: sabKey
          ? { action: "replace", value: sabKey }
          : { action: "retain" },
        defaultCategory: String(form.get("defaultCategory") ?? "") || null,
        maxNzbBytes: 20 * 1024 * 1024
      });
      await mutate("/api/settings/sabnzbd/test", "POST");
      setSabKey("");
    });
  };

  const saveQbittorrent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run("qBittorrent save", async () => {
      await mutate("/api/settings/qbittorrent", "PUT", {
        baseUrl: form.get("baseUrl"),
        username: form.get("username"),
        password: qbPassword
          ? { action: "replace", value: qbPassword }
          : { action: "retain" },
        defaultCategory: String(form.get("defaultCategory") ?? "") || null
      });
      await mutate("/api/settings/qbittorrent/test", "POST");
      setQbPassword("");
    });
  };

  const saveProwlarr = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run("Prowlarr save", async () => {
      await mutate("/api/settings/prowlarr", "PUT", {
        baseUrl: form.get("baseUrl"),
        apiKey: clearProwlarrKey
          ? { action: "clear" }
          : prowlarrKey
            ? { action: "replace", value: prowlarrKey }
            : { action: "retain" },
        timeoutMs: Number(form.get("timeoutMs"))
      });
      const result = await mutate("/api/settings/prowlarr/test", "POST") as {
        indexers: typeof discoveredIndexers;
      };
      setDiscoveredIndexers(result.indexers);
      setProwlarrKey("");
      setClearProwlarrKey(false);
    });
  };

  return (
    <div className="page">
      <header className="page-header settings-header">
        <div>
          <p className="eyebrow">SYSTEM CONFIGURATION</p>
          <h1>Settings</h1>
          <p>Catalog, platform, Prowlarr, and download-client connections.</p>
        </div>
        {message && <p className="notice" role="status">{message}</p>}
      </header>

      <div className="settings-grid">
        <Card id="igdb" className="settings-card">
          <SettingsCardHeader
            number="01"
            title="IGDB catalog"
            status={settings.igdb?.lastTestStatus}
          />
          <p className="muted">
            Search metadata comes from IGDB using a Twitch developer
            application.
          </p>
          <form onSubmit={saveIgdb} className="form-grid">
            <label>
              Client ID
              <Input
                name="clientId"
                required
                defaultValue={settings.igdb?.clientId}
                autoComplete="off"
              />
            </label>
            <label>
              Client secret
              <Input
                type="password"
                value={igdbSecret}
                onChange={(event) => setIgdbSecret(event.target.value)}
                // Blank submits `{ action: "retain" }`, which the service
                // rejects with "A replacement secret is required" when nothing
                // is stored yet. Required only in that case, so the retain
                // path still works once a secret exists.
                required={!settings.igdb?.hasClientSecret}
                placeholder={settings.igdb?.hasClientSecret
                  ? "Leave blank to retain"
                  : "Required"}
                autoComplete="new-password"
              />
              <CredentialState saved={settings.igdb?.hasClientSecret ?? false} />
            </label>
            <div className="button-row">
              <Button type="submit" disabled={busy !== null}>
                <Save aria-hidden="true" /> Save and test
              </Button>
              <Button variant="secondary" asChild>
                <a
                  href="https://dev.twitch.tv/console/apps"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Twitch Developer Portal
                  <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            </div>
          </form>
        </Card>

        <Card id="sabnzbd" className="settings-card">
          <SettingsCardHeader
            number="02"
            title="SABnzbd"
            status={settings.sabnzbd?.lastTestStatus}
          />
          <p className="muted">
            Gamarr retrieves the NZB and uploads its bytes to SABnzbd.
          </p>
          <form onSubmit={saveSab} className="form-grid">
            <label>
              Base URL
              <Input
                name="baseUrl"
                type="url"
                required
                placeholder="http://sabnzbd:8080"
                defaultValue={settings.sabnzbd?.baseUrl}
              />
            </label>
            <label>
              API key
              <Input
                type="password"
                value={sabKey}
                onChange={(event) => setSabKey(event.target.value)}
                required={!settings.sabnzbd?.hasApiKey}
                placeholder={settings.sabnzbd?.hasApiKey
                  ? "Leave blank to retain"
                  : "Required"}
                autoComplete="new-password"
              />
              <CredentialState saved={settings.sabnzbd?.hasApiKey ?? false} />
            </label>
            <label>
              Default category
              <Input
                name="defaultCategory"
                defaultValue={settings.sabnzbd?.defaultCategory ?? ""}
                placeholder="games"
              />
            </label>
            <Button type="submit" disabled={busy !== null}>
              <Save aria-hidden="true" /> Save and test
            </Button>
          </form>
        </Card>

        <Card id="qbittorrent" className="settings-card">
          <SettingsCardHeader
            number="03"
            title="qBittorrent"
            status={settings.qbittorrent?.lastTestStatus}
          />
          <p className="muted">
            Gamarr sends selected torrent releases to qBittorrent.
          </p>
          <form onSubmit={saveQbittorrent} className="form-grid">
            <label htmlFor="qbittorrent-base-url">
              Base URL
              <Input
                id="qbittorrent-base-url"
                name="baseUrl"
                type="url"
                required
                placeholder="http://qbittorrent:8080"
                defaultValue={settings.qbittorrent?.baseUrl}
              />
            </label>
            <label htmlFor="qbittorrent-username">
              Username
              <Input
                id="qbittorrent-username"
                name="username"
                required
                defaultValue={settings.qbittorrent?.username}
                autoComplete="username"
              />
            </label>
            <label htmlFor="qbittorrent-password">
              Password
              <Input
                id="qbittorrent-password"
                type="password"
                value={qbPassword}
                onChange={(event) => setQbPassword(event.target.value)}
                required={!settings.qbittorrent?.hasPassword}
                placeholder={settings.qbittorrent?.hasPassword
                  ? "Leave blank to retain"
                  : "Required"}
                autoComplete="new-password"
              />
              <CredentialState saved={settings.qbittorrent?.hasPassword ?? false} />
            </label>
            <label htmlFor="qbittorrent-default-category">
              Default category
              <Input
                id="qbittorrent-default-category"
                name="defaultCategory"
                defaultValue={settings.qbittorrent?.defaultCategory ?? ""}
                placeholder="games"
              />
            </label>
            <Button type="submit" disabled={busy !== null}>
              <Save aria-hidden="true" /> Save and test
            </Button>
          </form>
        </Card>

        <Card id="prowlarr" className="settings-card settings-card-wide">
          <SettingsCardHeader
            number="04"
            title="Prowlarr"
            status={settings.prowlarr?.lastTestStatus}
          />
          <p className="muted">
            Gamarr searches every enabled indexer from this Prowlarr connection.
          </p>
          <form onSubmit={saveProwlarr} className="form-grid">
            <label>
              Base URL
              <Input
                name="baseUrl"
                type="url"
                required
                placeholder="http://prowlarr:9696"
                defaultValue={settings.prowlarr?.baseUrl}
              />
            </label>
            <label>
              API key
              <Input
                type="password"
                value={prowlarrKey}
                onChange={(event) => {
                  setProwlarrKey(event.target.value);
                  if (event.target.value) setClearProwlarrKey(false);
                }}
                required={!settings.prowlarr?.hasApiKey && !clearProwlarrKey}
                placeholder={settings.prowlarr?.hasApiKey
                  ? "Leave blank to retain"
                  : "Required"}
                autoComplete="new-password"
              />
              <CredentialState saved={settings.prowlarr?.hasApiKey ?? false} />
            </label>
            {settings.prowlarr?.hasApiKey && (
              <label className="platform-check">
                <input
                  type="checkbox"
                  checked={clearProwlarrKey}
                  onChange={(event) => setClearProwlarrKey(event.target.checked)}
                />
                <span>Clear saved API key</span>
              </label>
            )}
            <label>
              Timeout (milliseconds)
              <Input
                name="timeoutMs"
                type="number"
                min="1000"
                max="30000"
                required
                defaultValue={settings.prowlarr?.timeoutMs ?? 10_000}
              />
            </label>
            <Button type="submit" disabled={busy !== null}>
              <TestTube2 aria-hidden="true" /> Save and test
            </Button>
          </form>
          {discoveredIndexers.length > 0 && (
            <div className="connection-list">
              <p className="muted">Indexers are managed in Prowlarr.</p>
              {discoveredIndexers.map((indexer) => (
                <div className="connection-row" key={indexer.id}>
                  <div>
                    <strong>{indexer.name}</strong>
                    <span className="mono">
                      <span>{indexer.protocol}</span> · <span>priority {indexer.priority}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card id="platforms" className="settings-card settings-card-wide">
          <SettingsCardHeader
            number="05"
            title="Platforms"
            status={platforms.some((platform) => platform.visible) ? "ready" : null}
          />
          <div className="section-toolbar">
            <p className="muted">Choose every console you want in Discover.</p>
            <Button
              variant="secondary"
              onClick={() => void run("Platform refresh", () =>
                mutate("/api/platforms/sync", "POST"))}
              disabled={busy !== null}
            >
              <RefreshCw aria-hidden="true" /> Refresh platforms
            </Button>
          </div>
          {platforms.length === 0 ? (
            <p className="inline-empty">
              Connect IGDB and refresh platforms to build this shelf.
            </p>
          ) : (
            <div className="platform-check-grid">
              {platforms.map((platform) => (
                <label className="platform-check" key={platform.id}>
                  <input
                    type="checkbox"
                    defaultChecked={platform.visible}
                    onChange={(event) => void run(
                      `${platform.name} update`,
                      () => mutate("/api/platforms", "PUT", {
                        id: platform.id,
                        visible: event.target.checked,
                        aliases: platform.aliases
                      })
                    )}
                  />
                  <span>{platform.name}</span>
                  {platform.abbreviation && <small>{platform.abbreviation}</small>}
                </label>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function SettingsCardHeader({
  number,
  title,
  status
}: {
  number: string;
  title: string;
  status: string | null | undefined;
}) {
  return (
    <header className="settings-card-header">
      <span className="section-number">{number}</span>
      <h2>{title}</h2>
      <StatusPill status={status ?? null} label={status ?? "Untested"} />
    </header>
  );
}
