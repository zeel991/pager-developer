import type { NextConfig } from 'next';

const config: NextConfig = {
  // The dashboard reads through the API rather than the database directly,
  // because PGlite admits only one process per data directory.
  env: { PAGER_API_URL: process.env.PAGER_API_URL ?? 'http://127.0.0.1:4000' },
};

export default config;
