/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: ["@apex/db"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "CDN-Cache-Control",
            value: "max-age=60, stale-while-revalidate=300",
          },
          {
            key: "Cloudflare-CDN-Cache-Control",
            value: "max-age=60, stale-while-revalidate=300",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
