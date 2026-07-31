import {
  Check,
  Circle,
  Database,
  Download,
  Gamepad2,
  Radio
} from "lucide-react";
import Link from "next/link";
import type { Route } from "next";

import { Button } from "@/components/ui/button";

export interface SetupReadiness {
  igdbReady: boolean;
  platformsReady: boolean;
  indexerReady: boolean;
  sabnzbdReady: boolean;
}

const steps = [
  {
    key: "igdbReady" as const,
    title: "Connect the game catalog",
    copy: "Use a free Twitch developer application to search IGDB.",
    icon: Gamepad2,
    href: "/settings#igdb",
    action: "Continue with IGDB"
  },
  {
    key: "platformsReady" as const,
    title: "Choose your platforms",
    copy: "Refresh the catalog, then show only the consoles you use.",
    icon: Database,
    href: "/settings#platforms",
    action: "Continue with platforms"
  },
  {
    key: "indexerReady" as const,
    title: "Add a Newznab indexer",
    copy: "Gamarr searches enabled indexers and explains each match.",
    icon: Radio,
    href: "/settings#indexers",
    action: "Continue with indexers"
  },
  {
    key: "sabnzbdReady" as const,
    title: "Connect SABnzbd",
    copy: "Selected NZBs are uploaded directly to your download client.",
    icon: Download,
    href: "/settings#sabnzbd",
    action: "Continue with SABnzbd"
  }
];

export function SetupScreen({ readiness }: { readiness: SetupReadiness }) {
  const completed = steps.filter((step) => readiness[step.key]).length;
  const next = steps.find((step) => !readiness[step.key]);
  return (
    <div className="page page-narrow">
      <header className="page-header setup-heading">
        <p className="eyebrow">FIRST RUN · CHECKLIST</p>
        <h1>Prepare your game archive</h1>
        <p>
          Four connections stand between this empty shelf and your first
          release search. Progress is saved as you go.
        </p>
        <div
          className="setup-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={4}
          aria-valuenow={completed}
        >
          <span style={{ width: `${completed * 25}%` }} />
        </div>
        <strong>{completed} of 4 complete</strong>
      </header>
      <ol className="setup-list">
        {steps.map((step, index) => {
          const done = readiness[step.key];
          const Icon = step.icon;
          return (
            <li className={done ? "setup-step setup-step-done" : "setup-step"} key={step.key}>
              <span className="step-number">{String(index + 1).padStart(2, "0")}</span>
              <Icon className="step-icon" aria-hidden="true" />
              <div>
                <h2>{step.title}</h2>
                <p>{step.copy}</p>
              </div>
              <span className="step-state">
                {done
                  ? <><Check aria-hidden="true" /> Ready</>
                  : <><Circle aria-hidden="true" /> Pending</>}
              </span>
            </li>
          );
        })}
      </ol>
      {next ? (
        <Button asChild>
          <Link href={next.href as Route}>{next.action}</Link>
        </Button>
      ) : (
        <Button asChild>
          <Link href={"/discover" as Route}>Start discovering games</Link>
        </Button>
      )}
    </div>
  );
}
