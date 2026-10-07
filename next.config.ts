import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Imports paste whole repositories (all file contents as JSON) into a Server Action.
    serverActions: { bodySizeLimit: "50mb" },
  },
};

export default nextConfig;
