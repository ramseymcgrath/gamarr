"use client";

import {
  Compass,
  LibraryBig,
  ListChecks,
  Settings
} from "lucide-react";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

const destinations = [
  { href: "/discover", label: "Discover", icon: Compass },
  { href: "/", label: "Library", icon: LibraryBig },
  { href: "/activity", label: "Activity", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({
  children,
  pathname: suppliedPathname
}: {
  children: ReactNode;
  pathname?: string;
}) {
  const currentPathname = usePathname();
  const pathname = suppliedPathname ?? currentPathname;
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="rail">
        <Link className="wordmark" href="/" aria-label="Gamarr library">
          <span aria-hidden="true" className="wordmark-mark">G</span>
          <span>GAMARR<small>GAME ARCHIVE</small></span>
        </Link>
        <p className="rail-note">LAN CONSOLE · V1</p>
      </aside>
      <div className="responsive-nav">
        <PrimaryNavigation pathname={pathname} />
      </div>
      <div className="content-frame">
        <header className="mobile-header">
          <Link className="wordmark" href="/" aria-label="Gamarr library">
            <span aria-hidden="true" className="wordmark-mark">G</span>
            <span>GAMARR</span>
          </Link>
        </header>
        <main id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}

function PrimaryNavigation({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Primary" className="primary-nav">
      {destinations.map(({ href, label, icon: Icon }) => {
        const active = href === "/"
          ? pathname === "/" || pathname.startsWith("/library")
          : pathname.startsWith(href);
        return (
          <Link
            className={cn("nav-link", active && "nav-link-active")}
            href={href as Route}
            aria-current={active ? "page" : undefined}
            key={href}
          >
            <Icon aria-hidden="true" size={19} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
