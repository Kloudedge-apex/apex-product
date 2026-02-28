import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Apex AI Workforce Platform | Deploy AI Agents in Minutes",
  description: "Deploy autonomous AI agents for Sales, Marketing, and Operations. Configure once, deploy in minutes, scale without hiring. Start your free trial today.",
  openGraph: {
    title: "Apex AI Workforce Platform",
    description: "Deploy autonomous AI agents for Sales, Marketing, and Operations.",
    type: "website",
    url: "https://apex.kloudedge.com",
  },
};

const agentShowcase = [
  { name: "SDR Agent", domain: "Sales", desc: "Researches prospects, qualifies leads, and drafts personalized outreach emails.", output: "Generated 142 emails, 23% response rate, 8 meetings booked" },
  { name: "Content Writer", domain: "Marketing", desc: "Creates on-brand content for LinkedIn, Twitter, and blogs on autopilot.", output: "Published 12 posts, 2.4K impressions, 89 engagements" },
  { name: "CRM Sync Agent", domain: "Sales", desc: "Keeps your CRM up-to-date by syncing data across email, calendar, and deals.", output: "Synced 234 contacts, updated 18 deals, flagged 3 conflicts" },
  { name: "Inbox Monitor", domain: "Ops", desc: "Triages your inbox, categorizes emails, and drafts replies for priority messages.", output: "Processed 89 emails, 12 flagged urgent, 5 auto-replied" },
  { name: "Social Engagement", domain: "Marketing", desc: "Monitors social media for relevant conversations and engages thoughtfully.", output: "Monitored 340 posts, engaged with 28, gained 156 impressions" },
  { name: "Reporting Agent", domain: "Ops", desc: "Generates daily and weekly reports with actionable insights from your data.", output: "Weekly report: $127K pipeline, 23% response rate, +15% vs last week" },
];

const faqs = [
  { q: "How do AI agents work?", a: "Each agent is powered by advanced LLMs with a specialized system prompt, configured for your specific use case. They connect to your tools via integrations and execute tasks on a schedule or on-demand." },
  { q: "Do I need technical knowledge?", a: "Not at all. Our onboarding wizard guides you through template selection, integration setup, and agent configuration in under 5 minutes." },
  { q: "What integrations are supported?", a: "We currently support Gmail, Outlook, and HubSpot, with Salesforce, LinkedIn, Slack, and more coming soon." },
  { q: "Can I try it for free?", a: "Yes! Every account starts with a 3-day free trial. No credit card required. Deploy your first agent in minutes." },
  { q: "How is pricing calculated?", a: "Pricing is based on your plan tier which determines the number of agents and token limits. See our pricing section for details." },
  { q: "Is my data secure?", a: "All OAuth credentials are encrypted with AES-256-GCM. We never store raw passwords. Data is scoped per organization with strict access controls." },
];

const howItWorks = [
  { step: "1", title: "Sign Up", desc: "Create your account in 30 seconds. No credit card required." },
  { step: "2", title: "Pick Agents", desc: "Choose from 6 pre-built AI agent templates across Sales, Marketing, and Ops." },
  { step: "3", title: "Connect Tools", desc: "Link your Gmail, HubSpot, or other integrations with one click." },
  { step: "4", title: "Deploy", desc: "Configure your agent and deploy. Watch results flow in automatically." },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-apex-border sticky top-0 z-50 bg-apex-navy/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-apex-indigo rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">A</span>
            </div>
            <span className="text-xl font-bold text-white">Apex</span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm">
            <a href="#agents" className="text-apex-muted hover:text-white transition-colors">Agents</a>
            <a href="#how-it-works" className="text-apex-muted hover:text-white transition-colors">How It Works</a>
            <a href="#pricing" className="text-apex-muted hover:text-white transition-colors">Pricing</a>
            <a href="#faq" className="text-apex-muted hover:text-white transition-colors">FAQ</a>
          </nav>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-apex-muted hover:text-white transition-colors text-sm font-medium">Sign In</Link>
            <Link href="/signup" className="btn-primary text-sm">Get Started Free</Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="max-w-7xl mx-auto px-6 py-24 md:py-32 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-apex-indigo/10 border border-apex-indigo/20 text-apex-indigo-light text-sm mb-8">
            <span className="w-2 h-2 rounded-full bg-apex-indigo animate-pulse" />
            Now in Beta
          </div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-tight">
            Deploy Your AI Workforce
            <br />
            <span className="text-apex-indigo-light">in Minutes</span>
          </h1>
          <p className="text-xl md:text-2xl text-apex-muted max-w-3xl mx-auto mb-12">
            Autonomous AI agents for Sales, Marketing, and Operations.
            Configure once. Deploy in minutes. Scale without hiring.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Link href="/signup" className="btn-primary text-lg px-8 py-3.5">Start Free Trial</Link>
            <a href="#how-it-works" className="btn-secondary text-lg px-8 py-3.5">See How It Works</a>
          </div>
        </section>

        {/* Social Proof Stats */}
        <section className="border-y border-apex-border bg-apex-surface/50">
          <div className="max-w-7xl mx-auto px-6 py-12 grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            <div>
              <p className="text-3xl md:text-4xl font-bold text-apex-indigo-light">6</p>
              <p className="text-apex-muted mt-1 text-sm">AI Agent Templates</p>
            </div>
            <div>
              <p className="text-3xl md:text-4xl font-bold text-apex-indigo-light">14</p>
              <p className="text-apex-muted mt-1 text-sm">Agents Deployed</p>
            </div>
            <div>
              <p className="text-3xl md:text-4xl font-bold text-apex-indigo-light">$2.7M</p>
              <p className="text-apex-muted mt-1 text-sm">Pipeline Generated</p>
            </div>
            <div>
              <p className="text-3xl md:text-4xl font-bold text-apex-indigo-light">&lt;5 min</p>
              <p className="text-apex-muted mt-1 text-sm">Time to Deploy</p>
            </div>
          </div>
        </section>

        {/* Problem/Solution */}
        <section className="max-w-7xl mx-auto px-6 py-24">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">Stop Hiring. Start Deploying.</h2>
          <p className="text-apex-muted text-center mb-16 max-w-2xl mx-auto">Every growing team faces the same challenge: too many tasks, not enough people. AI agents handle the repetitive work so your team can focus on what matters.</p>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              { pain: "Manual prospecting takes 4+ hours/day", solution: "SDR Agent researches, qualifies, and emails prospects automatically", icon: "💰", domain: "Sales" },
              { pain: "Content creation is a full-time job", solution: "Content Writer creates on-brand posts and articles on schedule", icon: "📢", domain: "Marketing" },
              { pain: "Email overload and missed follow-ups", solution: "Inbox Monitor triages, prioritizes, and drafts replies instantly", icon: "⚙️", domain: "Operations" },
            ].map((item) => (
              <div key={item.domain} className="card hover:border-apex-indigo/30 transition-colors">
                <div className="text-4xl mb-4">{item.icon}</div>
                <span className="text-xs font-medium text-apex-indigo-light">{item.domain}</span>
                <p className="text-sm text-red-400/80 line-through mt-2 mb-1">{item.pain}</p>
                <p className="text-sm text-green-400">{item.solution}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How It Works */}
        <section id="how-it-works" className="max-w-7xl mx-auto px-6 py-24">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-16">How It Works</h2>
          <div className="grid md:grid-cols-4 gap-8">
            {howItWorks.map((step) => (
              <div key={step.step} className="text-center">
                <div className="w-12 h-12 bg-apex-indigo/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <span className="text-xl font-bold text-apex-indigo-light">{step.step}</span>
                </div>
                <h3 className="font-semibold mb-2">{step.title}</h3>
                <p className="text-sm text-apex-muted">{step.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Agent Showcase */}
        <section id="agents" className="max-w-7xl mx-auto px-6 py-24">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">Meet Your AI Agents</h2>
          <p className="text-apex-muted text-center mb-16 max-w-2xl mx-auto">Each agent is a specialized AI worker with deep domain expertise. Pick a template, configure it, and deploy.</p>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {agentShowcase.map((agent) => (
              <div key={agent.name} className="card hover:border-apex-indigo/30 transition-colors group">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold">{agent.name}</h3>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-apex-indigo/10 text-apex-indigo-light">{agent.domain}</span>
                </div>
                <p className="text-sm text-apex-muted mb-4">{agent.desc}</p>
                <div className="bg-apex-surface/50 rounded-lg p-3 border border-apex-border">
                  <p className="text-xs text-apex-muted mb-1">Example output:</p>
                  <p className="text-xs text-green-400 font-mono">{agent.output}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="max-w-7xl mx-auto px-6 py-24">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">Simple, Transparent Pricing</h2>
          <p className="text-apex-muted text-center mb-16">Start free. Scale when ready.</p>
          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {[
              { name: "Starter", price: "$49", desc: "For small teams getting started", features: ["1-2 AI agents", "1 domain (Sales OR Marketing OR Ops)", "Pre-built templates", "10K tokens/run", "Community support"] },
              { name: "Growth", price: "$149", desc: "For growing teams", features: ["5-8 AI agents", "Multi-domain access", "Custom workflows", "50K tokens/run", "Advanced integrations", "Priority support", "Analytics dashboard"], popular: true },
              { name: "Enterprise", price: "Custom", desc: "For organizations at scale", features: ["Unlimited agents", "All domains + custom", "Unlimited tokens", "Dedicated infrastructure", "White-glove onboarding", "SLA guarantees", "SSO & SAML"] },
            ].map((plan) => (
              <div key={plan.name}
                className={`card relative ${"popular" in plan && plan.popular ? "border-apex-indigo ring-1 ring-apex-indigo" : ""}`}>
                {"popular" in plan && plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-apex-indigo rounded-full text-xs font-medium">Most Popular</div>
                )}
                <h3 className="text-lg font-semibold">{plan.name}</h3>
                <p className="text-3xl font-bold mt-2">
                  {plan.price}
                  {plan.price !== "Custom" && <span className="text-lg text-apex-muted font-normal">/mo</span>}
                </p>
                <p className="text-apex-muted text-sm mt-1">{plan.desc}</p>
                <ul className="mt-6 space-y-3">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm">
                      <span className="text-apex-indigo-light">✓</span>{f}
                    </li>
                  ))}
                </ul>
                <Link href="/signup"
                  className={`mt-8 block text-center py-2.5 rounded-lg font-medium text-sm ${"popular" in plan && plan.popular ? "btn-primary" : "btn-secondary"}`}>
                  {plan.price === "Custom" ? "Contact Sales" : "Start Free Trial"}
                </Link>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="max-w-3xl mx-auto px-6 py-24">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-16">Frequently Asked Questions</h2>
          <div className="space-y-4">
            {faqs.map((faq) => (
              <details key={faq.q} className="card group">
                <summary className="cursor-pointer font-medium flex items-center justify-between list-none">
                  {faq.q}
                  <span className="text-apex-muted group-open:rotate-180 transition-transform">▼</span>
                </summary>
                <p className="text-sm text-apex-muted mt-4">{faq.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="max-w-7xl mx-auto px-6 py-24 text-center">
          <div className="card bg-gradient-to-br from-apex-indigo/10 to-apex-navy-dark border-apex-indigo/20 py-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">Ready to Deploy Your AI Workforce?</h2>
            <p className="text-apex-muted mb-8 max-w-lg mx-auto">Join the beta and get your first agent running in under 5 minutes. No credit card required.</p>
            <Link href="/signup" className="btn-primary text-lg px-8 py-3.5">Start Free Trial</Link>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-apex-border">
        <div className="max-w-7xl mx-auto px-6 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-6 h-6 bg-apex-indigo rounded flex items-center justify-center">
                  <span className="text-white font-bold text-xs">A</span>
                </div>
                <span className="font-bold text-white">Apex</span>
              </div>
              <p className="text-sm text-apex-muted">AI workforce platform by Kloudedge.</p>
            </div>
            <div>
              <h4 className="font-medium text-sm mb-3">Product</h4>
              <ul className="space-y-2 text-sm text-apex-muted">
                <li><a href="#agents" className="hover:text-white transition-colors">Agents</a></li>
                <li><a href="#pricing" className="hover:text-white transition-colors">Pricing</a></li>
                <li><a href="#how-it-works" className="hover:text-white transition-colors">How It Works</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium text-sm mb-3">Company</h4>
              <ul className="space-y-2 text-sm text-apex-muted">
                <li><a href="#faq" className="hover:text-white transition-colors">FAQ</a></li>
                <li><Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link></li>
                <li><Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium text-sm mb-3">Get Started</h4>
              <ul className="space-y-2 text-sm text-apex-muted">
                <li><Link href="/signup" className="hover:text-white transition-colors">Sign Up</Link></li>
                <li><Link href="/login" className="hover:text-white transition-colors">Sign In</Link></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-apex-border pt-8 text-center text-apex-muted text-sm">
            © 2026 Kloudedge Apex LLP. All rights reserved.
          </div>
        </div>
      </footer>

      {/* JSON-LD Structured Data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            "name": "Apex AI Workforce Platform",
            "applicationCategory": "BusinessApplication",
            "operatingSystem": "Web",
            "description": "Deploy autonomous AI agents for Sales, Marketing, and Operations.",
            "offers": [
              { "@type": "Offer", "name": "Starter", "price": "49", "priceCurrency": "USD", "billingIncrement": "P1M" },
              { "@type": "Offer", "name": "Growth", "price": "149", "priceCurrency": "USD", "billingIncrement": "P1M" },
            ],
            "creator": { "@type": "Organization", "name": "Kloudedge Apex LLP" },
          }),
        }}
      />
    </div>
  );
}
