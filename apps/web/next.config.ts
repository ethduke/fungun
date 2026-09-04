import type { NextConfig } from 'next';

const nextConfig: NextConfig = process.env.FUNGUN_WEB_TARGET === 'fly'
  ? { output: 'standalone' }
  : {};

export default nextConfig;
