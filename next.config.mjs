/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR?.trim() || '.next',
  env: {
    NEXT_PUBLIC_DEPLOYMENT_ENV: process.env.VERCEL_ENV || process.env.NEXT_PUBLIC_DEPLOYMENT_ENV || '',
  },
};

export default nextConfig;
