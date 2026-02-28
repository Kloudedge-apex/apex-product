import Link from "next/link";
import type { Metadata } from "next";
import { AgentDemo } from "@/components/landing/AgentDemo";
import { AgentShowcase } from "@/components/landing/AgentShowcase";
import { OldVsNewComparison, CompetitorTable } from "@/components/landing/ComparisonTable";
import { ScrollReveal } from "@/components/landing/ScrollReveal";
import { PricingSection } from "@/components/landing/PricingSection";

export const metadata: Metadata = {
  title: "Apex AI Workforce Platform | Deploy AI Agents in Minutes",
  description:
    "Deploy autonomous AI agents for Sales, Marketing, and Operations. Configure once, deploy in minutes, scale without hiring. Start your free trial today.",
  openGraph: {
    title: "Apex AI Workforce Platform",
    description:
      "Deploy autonomous AI agents for Sales, Marketing, and Operations.",
    type: "website",
    url: "https://apex.kloudedge.com",
  },
};

const integrations = [
  { name: "OpenAI", icon: "⚡" },
  { name: "Gmail", icon: "📧" },
  { name: "Outlook", icon: "📨" },
  { name: "HubSpot", icon: "🔶" },
  { name: "Azure", icon: "☁️" },
];

const timelineSteps = [
  {
    step: "01",
    title: "Sign Up",
    desc: "Create your account in 30 seconds — no credit card, no sales call.",
    detail: "Just email and password. You're in.",
  },
  {
    step: "02",
    title: "Pick Your Agent",
    desc: "Choose from 6 battle-tested templates. SDR, Content, CRM, Inbox, Social, Reporting.",
    detail: "Each template comes pre-configured with best practices.",
  },
  {
    step: "03",
    title: "Connect Your Tools",
    desc: "One-click OAuth for Gmail, Outlook, HubSpot.",
    icons: ["📧", "📨", "🔶"],
  },
  {
    step: "04",
    title: "Deploy & Watch",
    desc: "Hit deploy. Your agent starts working immediately.",
    detail: "Real-time dashboard shows every step, every tool call, every result.",
  },
];

const faqs = [
  {
    q: "How do AI agents work?",
    a: "Each agent is powered by advanced LLMs with a specialized system prompt, configured for your specific use case. They connect to your tools via integrations and execute tasks on a schedule or on-demand.",
  },
  {
    q: "Do I need technical knowledge?",
    a: "Not at all. Our onboarding wizard guides you through template selection, integration setup, and agent configuration in under 5 minutes.",
  },
  {
    q: "What integrations are supported?",
    a: "We currently support Gmail, Outlook, and HubSpot, with Salesforce, LinkedIn, Slack, and more coming soon.",
  },
  {
    q: "Can I try it for free?",
    a: "Yes! Every account starts with a 3-day free trial. No credit card required. Deploy your first agent in minutes.",
  },
  {
    q: "How is pricing calculated?",
    a: "Pricing is based on your plan tier which determines the number of agents and token limits. See our pricing section for details.",
  },
  {
    q: "Is my data secure?",
    a: "All OAuth credentials are encrypted with AES-256-GCM. We never store raw passwords. Data is scoped per organization with strict access controls.",
  },
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
            <a href="#demo" className="text-apex-muted hover:text-white transition-colors">Demo</a>
            <a href="#agents" className="text-apex-muted hover:text-white transition-colors">Agents</a>
            <a href="#how-it-works" className="text-apex-muted hover:text-white transition-colors">How It Works</a>
            <a href="#pricing" className="text-apex-muted hover:text-white transition-colors">Pricing</a>
            <a href="#faq" className="text-apex-muted hover:text-white transition-colors">FAQ</a>
          </nav>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-apex-muted hover:text-white transition-colors text-sm font-medium">
              Sign In
            </Link>
            <Link href="/signup" className="btn-primary text-sm">
              Get Started Free
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* ═══════════════════════════════════════════ */}
        {/* 1. HERO — Split layout with animated demo  */}
        {/* ═══════════════════════════════════════════ */}
        <section className="max-w-7xl mx-auto px-6 py-20 md:py-28">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            {/* Left — text */}
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-apex-indigo/10 border border-apex-indigo/20 text-apex-indigo-light text-sm mb-6">
                <span className="w-2 h-2 rounded-full bg-apex-indigo animate-pulse" />
                Trusted by 10+ teams in beta
              </div>
              <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6 leading-[1.1]">
                Your AI Workforce.
                <br />
                <span className="text-apex-indigo-light">Deployed in 5 Minutes.</span>
              </h1>
              <p className="text-lg md:text-xl text-apex-muted max-w-lg mb-8">
                Autonomous agents that research, email, post, report, and sync
                — while you focus on closing deals.
              </p>
              <div className="flex items-center gap-4 flex-wrap">
                <Link href="/signup" className="btn-primary text-lg px-8 py-3.5">
                  Start Free Trial
                </Link>
                <a href="#demo" className="btn-secondary text-lg px-8 py-3.5">
                  Watch Demo
                </a>
              </div>
              <p className="text-xs text-apex-muted mt-4">
                No credit card required · 3-day free trial · Cancel anytime
              </p>
            </div>

            {/* Right — animated agent demo */}
            <div className="lg:pl-4">
              <AgentDemo />
            </div>
          </div>
        </section>

        {/* ═══════════════════════════════════════════ */}
        {/* 2. LOGO BAR — Integrations                 */}
        {/* ═══════════════════════════════════════════ */}
        <section className="border-y border-apex-border bg-apex-surface/30">
          <div className="max-w-7xl mx-auto px-6 py-8">
            <p className="text-xs text-apex-muted text-center uppercase tracking-wider mb-6">
              Integrates with
            </p>
            <div className="flex items-center justify-center gap-8 md:gap-12 flex-wrap">
              {integrations.map((int) => (
                <div key={int.name} className="flex items-center gap-2 text-apex-muted/60 hover:text-apex-muted transition-colors">
                  <span className="text-2xl grayscale opacity-60">{int.icon}</span>
                  <span className="text-sm font-medium">{int.name}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ═══════════════════════════════════════════ */}
        {/* 3. OLD WAY vs APEX WAY                     */}
        {/* ═══════════════════════════════════════════ */}
        <section className="max-w-7xl mx-auto px-6 py-24">
          <ScrollReveal>
            <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">
              The Old Way vs The Apex Way
            </h2>
            <p className="text-apex-muted text-center mb-16 max-w-2xl mx-auto">
              Every growing team faces the same challenge: too many tasks, not enough people. Stop hiring for repetitive work.
            </p>
          </ScrollReveal>

          {/* Column headers */}
          <div className="grid md:grid-cols-2 gap-3 mb-6">
            <div className="text-center">
              <span className="text-sm font-medium text-red-400/80 uppercase tracking-wider">The Old Way</span>
            </div>
            <div className="text-center">
              <span className="text-sm font-medium text-green-400 uppercase tracking-wider">The Apex Way</span>
            </div>
          </div>

          <OldVsNewComparison />
        </section>

        {/* ═══════════════════════════════════════════ */}
        {/* 4. AGENT SHOWCASE — Interactive tabs        */}
        {/* ═══════════════════════════════════════════ */}
        <section id="agents" className="bg-apex-surface/30 border-y border-apex-border">
          <div id="demo" className="max-w-7xl mx-auto px-6 py-24">
            <ScrollReveal>
              <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">
                Meet Your AI Agents
              </h2>
              <p className="text-apex-muted text-center mb-12 max-w-2xl mx-auto">
                Each agent is a specialized AI worker. Pick a template, connect your tools, and watch it work. Click a tab to see a simulated run.
              </p>
            </ScrollReveal>
            <AgentShowcase />
          </div>
        </section>

        {/* ═══════════════════════════════════════════ */}
        {/* 5. HOW IT WORKS — Vertical timeline        */}
        {/* ═══════════════════════════════════════════ */}
        <section id="how-it-works" className="max-w-4xl mx-auto px-6 py-24">
          <ScrollReveal>
            <h2 className="text-3xl md:text-4xl font-bold text-center mb-16">
              How It Works
            </h2>
          </ScrollReveal>

          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-6 md:left-1/2 top-0 bottom-0 w-px bg-apex-border md:-translate-x-px" />

            {timelineSteps.map((step, i) => (
              <ScrollReveal key={step.step} delay={i * 100}>
                <div className={`relative flex items-start gap-6 mb-12 last:mb-0 ${
                  i % 2 === 0 ? "md:flex-row" : "md:flex-row-reverse"
                }`}>
                  {/* Step number bubble */}
                  <div className="relative z-10 flex-shrink-0 w-12 h-12 rounded-full bg-apex-indigo flex items-center justify-center text-sm font-bold md:absolute md:left-1/2 md:-translate-x-1/2">
                    {step.step}
                  </div>

                  {/* Content */}
                  <div className={`flex-1 card ${
                    i % 2 === 0
                      ? "md:mr-[calc(50%+2rem)] md:ml-0"
                      : "md:ml-[calc(50%+2rem)] md:mr-0"
                  }`}>
                    <h3 className="font-semibold text-lg mb-1">{step.title}</h3>
                    <p className="text-sm text-apex-muted">{step.desc}</p>
                    {step.detail && (
                      <p className="text-xs text-apex-muted/70 mt-2">{step.detail}</p>
                    )}
                    {step.icons && (
                      <div className="flex gap-3 mt-3">
                        {step.icons.map((icon) => (
                          <span key={icon} className="text-2xl">{icon}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </section>

        {/* ═══════════════════════════════════════════ */}
        {/* 6. COMPETITIVE DIFFERENTIATION              */}
        {/* ═══════════════════════════════════════════ */}
        <section className="bg-apex-surface/30 border-y border-apex-border">
          <div className="max-w-4xl mx-auto px-6 py-24">
            <ScrollReveal>
              <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">
                Not Just Another AI SDR
              </h2>
              <p className="text-apex-muted text-center mb-12 max-w-2xl mx-auto">
                Other tools give you a single-purpose chatbot for $5,000/month.
                Apex gives you a full AI workforce with real tool use, persistent memory,
                and multi-step execution.
              </p>
            </ScrollReveal>

            <ScrollReveal delay={100}>
              <div className="card overflow-hidden">
                <CompetitorTable />
              </div>
            </ScrollReveal>

            <ScrollReveal delay={200}>
              <p className="text-center text-apex-muted text-sm mt-8 max-w-xl mx-auto">
                Full AI workforce with real tool use, persistent memory, and multi-step
                execution — starting at <span className="text-apex-indigo-light font-semibold">$49/month</span>.
              </p>
            </ScrollReveal>
          </div>
        </section>

        {/* ═══════════════════════════════════════════ */}
        {/* 7. PRICING — Enhanced with annual toggle    */}
        {/* ═══════════════════════════════════════════ */}
        <section id="pricing" className="max-w-7xl mx-auto px-6 py-24">
          <ScrollReveal>
            <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">
              Simple, Transparent Pricing
            </h2>
            <p className="text-apex-muted text-center mb-12">
              Start free. Scale when ready.
            </p>
          </ScrollReveal>
          <PricingSection />
          <p className="text-center text-apex-muted text-sm mt-8">
            All plans include: 3-day free trial · No credit card required · Cancel anytime
          </p>
        </section>

        {/* ═══════════════════════════════════════════ */}
        {/* 8. TRUST SECTION — Built by practitioners   */}
        {/* ═══════════════════════════════════════════ */}
        <section className="border-y border-apex-border bg-apex-surface/30">
          <div className="max-w-4xl mx-auto px-6 py-20 text-center">
            <ScrollReveal>
              <p className="text-apex-indigo-light text-sm font-medium uppercase tracking-wider mb-4">
                Built by practitioners
              </p>
              <h2 className="text-2xl md:text-3xl font-bold mb-6 max-w-2xl mx-auto">
                &ldquo;We built Apex because we ran a 14-agent AI workforce ourselves.
                It&apos;s not theoretical — it&apos;s battle-tested.&rdquo;
              </h2>
              <div className="flex items-center justify-center gap-3">
                <div className="w-10 h-10 rounded-full bg-apex-indigo/20 flex items-center justify-center text-sm font-bold text-apex-indigo-light">
                  NK
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium">Nikhil K.</p>
                  <p className="text-xs text-apex-muted">Founder, Kloudedge</p>
                </div>
              </div>
            </ScrollReveal>
          </div>
        </section>

        {/* ═══════════════════════════════════════════ */}
        {/* 9. FAQ                                      */}
        {/* ═══════════════════════════════════════════ */}
        <section id="faq" className="max-w-3xl mx-auto px-6 py-24">
          <ScrollReveal>
            <h2 className="text-3xl md:text-4xl font-bold text-center mb-16">
              Frequently Asked Questions
            </h2>
          </ScrollReveal>
          <div className="space-y-4">
            {faqs.map((faq, i) => (
              <ScrollReveal key={faq.q} delay={i * 50}>
                <details className="card group">
                  <summary className="cursor-pointer font-medium flex items-center justify-between list-none">
                    {faq.q}
                    <span className="text-apex-muted group-open:rotate-180 transition-transform">▼</span>
                  </summary>
                  <p className="text-sm text-apex-muted mt-4">{faq.a}</p>
                </details>
              </ScrollReveal>
            ))}
          </div>
        </section>

        {/* ═══════════════════════════════════════════ */}
        {/* 10. FINAL CTA — Big, Bold                   */}
        {/* ═══════════════════════════════════════════ */}
        <section className="max-w-7xl mx-auto px-6 py-24">
          <div className="relative overflow-hidden rounded-2xl">
            {/* Gradient background */}
            <div className="absolute inset-0 bg-gradient-to-br from-apex-indigo/20 via-apex-navy-dark to-purple-900/20" />
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-apex-indigo/10 via-transparent to-transparent" />

            <div className="relative border border-apex-indigo/20 rounded-2xl px-8 py-16 md:py-20 text-center">
              <h2 className="text-3xl md:text-4xl font-bold mb-4">
                Deploy Your First Agent in 5 Minutes
              </h2>
              <p className="text-apex-muted mb-8 max-w-lg mx-auto">
                Join teams already using Apex to automate sales, marketing, and operations.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <Link href="/signup" className="btn-primary text-lg px-10 py-4 w-full sm:w-auto">
                  Start Free Trial
                </Link>
              </div>
              <p className="text-xs text-apex-muted mt-4">
                No credit card required. Cancel anytime.
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* ═══════════════════════════════════════════ */}
      {/* FOOTER — Enhanced                          */}
      {/* ═══════════════════════════════════════════ */}
      <footer className="border-t border-apex-border">
        <div className="max-w-7xl mx-auto px-6 py-12">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-8 mb-8">
            <div className="col-span-2 md:col-span-1">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-6 h-6 bg-apex-indigo rounded flex items-center justify-center">
                  <span className="text-white font-bold text-xs">A</span>
                </div>
                <span className="font-bold text-white">Apex</span>
              </div>
              <p className="text-sm text-apex-muted">
                AI workforce platform
                <br />
                by Kloudedge.
              </p>
            </div>
            <div>
              <h4 className="font-medium text-sm mb-3">Product</h4>
              <ul className="space-y-2 text-sm text-apex-muted">
                <li><a href="#agents" className="hover:text-white transition-colors">Agents</a></li>
                <li><a href="#pricing" className="hover:text-white transition-colors">Pricing</a></li>
                <li><a href="#how-it-works" className="hover:text-white transition-colors">How It Works</a></li>
                <li><a href="#demo" className="hover:text-white transition-colors">Demo</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium text-sm mb-3">Resources</h4>
              <ul className="space-y-2 text-sm text-apex-muted">
                <li><a href="#faq" className="hover:text-white transition-colors">FAQ</a></li>
                <li><span className="text-apex-muted/50 cursor-default">Documentation</span></li>
                <li><span className="text-apex-muted/50 cursor-default">Blog</span></li>
                <li><span className="text-apex-muted/50 cursor-default">Status</span></li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium text-sm mb-3">Company</h4>
              <ul className="space-y-2 text-sm text-apex-muted">
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
          <div className="border-t border-apex-border pt-8 flex flex-col md:flex-row items-center justify-between gap-4 text-apex-muted text-sm">
            <span>&copy; 2026 Kloudedge Apex LLP. All rights reserved.</span>
            <div className="flex items-center gap-4">
              <a href="https://linkedin.com" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">LinkedIn</a>
              <a href="https://x.com" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">X / Twitter</a>
            </div>
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
            name: "Apex AI Workforce Platform",
            applicationCategory: "BusinessApplication",
            operatingSystem: "Web",
            description:
              "Deploy autonomous AI agents for Sales, Marketing, and Operations. Autonomous agents that research, email, post, report, and sync.",
            offers: [
              { "@type": "Offer", name: "Starter", price: "49", priceCurrency: "USD", billingIncrement: "P1M" },
              { "@type": "Offer", name: "Growth", price: "149", priceCurrency: "USD", billingIncrement: "P1M" },
            ],
            creator: {
              "@type": "Organization",
              name: "Kloudedge Apex LLP",
            },
          }),
        }}
      />
    </div>
  );
}
