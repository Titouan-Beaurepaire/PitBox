import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // En développement, /api est relayé vers le serveur FastAPI ; en production, c'est Caddy qui s'en charge
  async rewrites() {
    return [{ source: "/api/:chemin*", destination: `${process.env.PITBOX_API ?? "http://localhost:8000"}/api/:chemin*` }];
  },
};

export default config;
