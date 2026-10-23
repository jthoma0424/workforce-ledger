/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { remotePatterns: [{ protocol: 'https', hostname: 'a.espncdn.com' }] },
};
export default nextConfig;
