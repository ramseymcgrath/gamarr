import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    unoptimized: true
  },
  serverExternalPackages: ["igdb-api-node"],
  typedRoutes: true
};

export default nextConfig;
