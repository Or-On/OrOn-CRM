import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@or-on/api-client", "@or-on/config", "@or-on/ui"],
  typedRoutes: true,
};

export default createNextIntlPlugin()(nextConfig);
