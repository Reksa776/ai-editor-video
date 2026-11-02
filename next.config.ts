import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Uploads are streamed to disk by the route handler, so no body-size buffering
  // is configured here. See src/app/api/upload/route.ts.
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
