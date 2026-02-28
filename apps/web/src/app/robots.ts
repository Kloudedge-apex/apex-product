import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://apex.kloudedge.com";

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/dashboard/", "/agents/", "/activity/", "/settings/", "/onboarding/", "/integrations/"],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
