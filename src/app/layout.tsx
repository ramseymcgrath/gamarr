import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/space-grotesk";
import "@fontsource/ibm-plex-mono/400.css";
import "@/app/globals.css";
import { AppShell } from "@/components/app-shell";
import { Providers } from "@/app/providers";

export const metadata: Metadata = {
  title: {
    default: "Gamarr",
    template: "%s · Gamarr"
  },
  description: "Search game releases and send them to SABnzbd."
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
