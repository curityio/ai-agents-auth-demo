import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Tell Next.js's standalone-mode file tracer to look up to the monorepo
  // root so workspace deps (packages/*) get bundled into .next/standalone.
  outputFileTracingRoot: join(__dirname, '../..'),
  experimental: {
    // Auth.js v5 uses async cookies; keep on App Router defaults.
  },
};
export default nextConfig;
