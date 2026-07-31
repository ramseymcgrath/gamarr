"use client";

import {
  ExternalLink,
  Plus,
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

  const addIndexer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run("Indexer save", async () => {
      const indexer = await mutate("/api/settings/indexers", "POST", {
        name: form.get("name"),
        baseUrl: form.get("baseUrl"),
        apiKey: { action: "replace", value: form.get("apiKey") },
        enabled: true,
        categoryIds: String(form.get("categories") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        timeoutMs: 10_000
      });
      await mutate(`/api/settings/indexers/${indexer.id}/test`, "POST");
      event.currentTarget.reset();
    });
  };

  return (
    <div className="page">
      <header className="page-header settings-header">
        <div>
          <p className="eyebrow">SYSTEM CONFIGURATION</p>
          <h1>Settings</h1>
          <p>Catalog, platform, indexer, and download-client connections.</p>
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

        <Card id="platforms" className="settings-card settings-card-wide">
          <SettingsCardHeader
            number="03"
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

        <Card id="indexers" className="settings-card settings-card-wide">
          <SettingsCardHeader
            number="04"
            title="Newznab indexers"
            status={settings.indexers.some((indexer) => indexer.enabled)
              ? "ready"
              : null}
          />
          {settings.indexers.length > 0 && (
            <div className="connection-list">
              {settings.indexers.map((indexer) => (
                <div className="connection-row" key={indexer.id}>
                  <div>
                    <strong>{indexer.name}</strong>
                    <span className="mono">{new URL(indexer.baseUrl).host}</span>
                  </div>
                  <CredentialState saved={indexer.hasApiKey} />
                  <StatusPill
                    status={indexer.lastTestStatus}
                    label={indexer.lastTestStatus ?? "Untested"}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => void run(
                      `${indexer.name} test`,
                      () => mutate(`/api/settings/indexers/${indexer.id}/test`, "POST")
                    )}
                  >
                    <TestTube2 aria-hidden="true" /> Test connection
                  </Button>
                </div>
              ))}
            </div>
          )}
          <form onSubmit={addIndexer} className="indexer-form">
            <label>Name<Input name="name" required placeholder="My indexer" /></label>
            <label>Newznab URL<Input name="baseUrl" type="url" required placeholder="https://indexer.example/api" /></label>
            <label>API key<Input name="apiKey" type="password" required autoComplete="new-password" /></label>
            <label>Categories<Input name="categories" placeholder="4050, 100000" /></label>
            <Button type="submit" disabled={busy !== null}>
              <Plus aria-hidden="true" /> Add and test indexer
            </Button>
          </form>
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
