import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  turbopack: {
    root: process.cwd(),
  },

  // Exclude local Python envs from file tracing (they contain external symlinks).
  outputFileTracingExcludes: {
    '*': ['.venv/**', 'venv/**'],
  },

  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.ytimg.com' },
      { protocol: 'https', hostname: '**.ggpht.com' },
      { protocol: 'https', hostname: 'i.ytimg.com' },
      { protocol: 'https', hostname: 'i2.hdslb.com' },
      { protocol: 'https', hostname: 'i1.hdslb.com' },
      { protocol: 'https', hostname: 'i0.hdslb.com' },
    ],
  },
};

export default nextConfig;
