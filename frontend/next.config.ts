import type { NextConfig } from "next";

// All browser traffic goes to this app's origin; /api/* is proxied server-side
// to the FastAPI backend. One origin means no CORS anywhere, and over Tailscale
// only the frontend port needs serving.
const API_INTERNAL_URL = process.env.API_INTERNAL_URL || "http://localhost:8850";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        // Everything under /api except /api/auth/* (Auth.js catch-all route —
        // dynamic app routes match AFTER rewrites, so it must be excluded here).
        source: "/api/:path((?!auth).*)",
        destination: `${API_INTERNAL_URL}/api/:path`,
      },
    ];
  },
};

export default nextConfig;
