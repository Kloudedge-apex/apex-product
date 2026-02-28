import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "Apex AI Workforce Platform",
  description:
    "Deploy autonomous AI agents for Sales, Marketing, and Operations. Self-serve SaaS platform.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://apex.kloudedge.com"),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={{
        baseTheme: dark,
        variables: {
          colorPrimary: "#6366f1",
          colorBackground: "#0f172a",
          colorInputBackground: "#1a2332",
          colorInputText: "#ffffff",
        },
      }}
    >
      <html lang="en" className="dark">
        <body className="min-h-screen">
          <ToastProvider>{children}</ToastProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
