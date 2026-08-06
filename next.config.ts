import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    unoptimized: true
  },
  serverExternalPackages: ["igdb-api-node"],
  typedRoutes: true,
  /**
   * DBI's ApacheHTTP source is configured with a trailing slash
   * (`http://host:8989/api/dbi/`) and, like Apache's autoindex, the index it
   * fetches emits relative hrefs. Next's default trailing-slash redirect would
   * 308 that URL to `/api/dbi`, after which a relative href resolves against
   * `/api/` and every download 404s. Serving the slashed path directly is what
   * keeps the index and its links consistent.
   */
  skipTrailingSlashRedirect: true,
  /**
   * Disabling the built-in redirect above is global, so the UI's own
   * trailing-slash behaviour is restored here for everything outside `/api/`.
   */
  async redirects() {
    return [
      {
        source: "/:path((?!api/).*)/",
        destination: "/:path",
        permanent: true
      }
    ];
  }
};

export default nextConfig;
