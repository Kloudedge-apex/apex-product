import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | Apex AI Workforce Platform",
  description: "Privacy Policy for Apex AI Workforce Platform by Kloudedge.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-apex-border">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-apex-indigo rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">A</span>
            </div>
            <span className="text-xl font-bold text-white">Apex</span>
          </Link>
          <Link href="/" className="text-apex-muted hover:text-white text-sm">Back to Home</Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-apex-muted mb-12">Last updated: February 2026</p>

        <div className="prose prose-invert max-w-none space-y-8 text-apex-muted">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. Introduction</h2>
            <p>Kloudedge Apex LLP (&quot;Company,&quot; &quot;we,&quot; &quot;us&quot;) operates the Apex AI Workforce Platform. This Privacy Policy explains how we collect, use, and protect your information when you use our Service.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. Information We Collect</h2>
            <p><strong className="text-white">Account Information:</strong> Name, email address, organization name, and authentication credentials (managed via Clerk).</p>
            <p><strong className="text-white">Integration Credentials:</strong> OAuth tokens for connected services (Gmail, Outlook, HubSpot). These are encrypted with AES-256-GCM and never stored in plaintext.</p>
            <p><strong className="text-white">Usage Data:</strong> Agent configurations, run history, token usage, and performance metrics.</p>
            <p><strong className="text-white">Technical Data:</strong> Browser type, IP address, and device information for security and analytics.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. How We Use Your Information</h2>
            <p>We use your information to: (a) provide and maintain the Service; (b) process and execute AI agent tasks; (c) improve our Service and develop new features; (d) communicate with you about your account; (e) ensure security and prevent fraud.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. Data Storage and Security</h2>
            <p>Your data is stored on Azure-hosted PostgreSQL databases. OAuth credentials are encrypted using AES-256-GCM encryption. We implement industry-standard security measures including HTTPS, CORS policies, and organizational data scoping.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. Third-Party Services</h2>
            <p>We integrate with third-party services including: Clerk (authentication), Google (Gmail), Microsoft (Outlook), HubSpot (CRM), Razorpay (payments), and OpenAI (AI processing). Each has their own privacy policies governing their data handling.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">6. AI Processing</h2>
            <p>When AI agents execute tasks, your data may be processed by OpenAI&apos;s API. We send only the minimum necessary context for task execution. AI-generated outputs are stored in your account and are not shared with other users.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">7. Data Sharing</h2>
            <p>We do not sell your personal information. We may share data with: (a) service providers who assist in operating the Service; (b) legal authorities when required by law; (c) business successors in case of merger or acquisition.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">8. Data Retention</h2>
            <p>We retain your data for as long as your account is active. Upon account deletion, we will remove your data within 30 days, except where retention is required by law.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">9. Your Rights</h2>
            <p>You have the right to: (a) access your personal data; (b) correct inaccurate data; (c) delete your account and data; (d) export your data; (e) withdraw consent for data processing. Contact us at privacy@kloudedge.com to exercise these rights.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">10. Cookies</h2>
            <p>We use essential cookies for authentication and session management. We do not use tracking or advertising cookies.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">11. Changes to This Policy</h2>
            <p>We may update this Privacy Policy from time to time. We will notify you of material changes via email or through the Service.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">12. Contact</h2>
            <p>For privacy-related questions, contact us at privacy@kloudedge.com.</p>
          </section>
        </div>
      </main>
    </div>
  );
}
