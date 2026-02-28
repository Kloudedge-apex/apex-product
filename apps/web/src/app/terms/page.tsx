import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service | Apex AI Workforce Platform",
  description: "Terms of Service for Apex AI Workforce Platform by Kloudedge.",
};

export default function TermsPage() {
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
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-apex-muted mb-12">Last updated: February 2026</p>

        <div className="prose prose-invert max-w-none space-y-8 text-apex-muted">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. Acceptance of Terms</h2>
            <p>By accessing or using the Apex AI Workforce Platform (&quot;Service&quot;) provided by Kloudedge Apex LLP (&quot;Company,&quot; &quot;we,&quot; &quot;us&quot;), you agree to be bound by these Terms of Service. If you do not agree, you may not use the Service.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. Description of Service</h2>
            <p>Apex is a SaaS platform that enables businesses to deploy autonomous AI agents for Sales, Marketing, and Operations tasks. The Service includes agent configuration, integration management, task execution, and monitoring capabilities.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. User Accounts</h2>
            <p>You must provide accurate information when creating an account. You are responsible for maintaining the confidentiality of your account credentials and for all activities under your account. You must notify us immediately of any unauthorized use.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. Acceptable Use</h2>
            <p>You agree not to: (a) use the Service for unlawful purposes; (b) attempt to gain unauthorized access to any systems; (c) use AI agents to send spam or unsolicited communications; (d) violate any applicable laws or regulations; (e) use the Service to harass, abuse, or harm others.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. Billing and Payment</h2>
            <p>Paid plans are billed on a monthly basis. You authorize us to charge your payment method for the applicable fees. Prices may change with 30 days&apos; notice. Refunds are handled on a case-by-case basis.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">6. Data and Privacy</h2>
            <p>Your use of the Service is subject to our <Link href="/privacy" className="text-apex-indigo-light hover:underline">Privacy Policy</Link>. You retain ownership of your data. We use your data only to provide and improve the Service.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">7. Third-Party Integrations</h2>
            <p>The Service connects to third-party platforms (Gmail, Outlook, HubSpot, etc.) via OAuth. We securely store encrypted credentials but are not responsible for third-party service availability or changes to their APIs.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">8. AI-Generated Content</h2>
            <p>AI agents generate content based on your configuration and templates. You are responsible for reviewing and approving all AI-generated outputs before they are sent externally. We do not guarantee the accuracy of AI outputs.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">9. Limitation of Liability</h2>
            <p>To the maximum extent permitted by law, the Company shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use of the Service.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">10. Termination</h2>
            <p>We may terminate or suspend your account at any time for violation of these Terms. You may cancel your account at any time through the Settings page. Upon termination, your data will be deleted within 30 days.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">11. Changes to Terms</h2>
            <p>We reserve the right to modify these Terms at any time. We will notify you of material changes via email or through the Service. Continued use after changes constitutes acceptance.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">12. Contact</h2>
            <p>For questions about these Terms, contact us at legal@kloudedge.com.</p>
          </section>
        </div>
      </main>
    </div>
  );
}
