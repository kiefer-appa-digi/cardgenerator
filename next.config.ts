import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The PDF writer reads the TTF files it embeds from disk at request time, so
   * the font directory has to be traced into the serverless bundle. Without
   * this, production export works locally and fails on Vercel with a missing
   * font file — the classic "works on my machine" for a Node function.
   */
  outputFileTracingIncludes: {
    "/api/**": ["./src/assets/fonts/**"],
    "/designs/**": ["./src/assets/fonts/**"],
    "/batch": ["./src/assets/fonts/**"],
    "/exports/**": ["./src/assets/fonts/**"],
  },
  serverExternalPackages: ["sharp", "exceljs"],
};

export default nextConfig;
