import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "Apex — The Agentic OS for Your Business",
  description:
    "The operating system for AI agents. Deploy, manage, and scale autonomous agents across your entire operation with production-grade reliability.",
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
