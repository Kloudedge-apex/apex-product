import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Hero */}
      <header className="border-b border-apex-border">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-apex-indigo rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">A</span>
            </div>
            <span className="text-xl font-bold text-white">Apex</span>
          </div>
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
        {/* Hero Section */}
        <section className="max-w-7xl mx-auto px-6 py-24 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-apex-indigo/10 border border-apex-indigo/20 text-apex-indigo-light text-sm mb-8">
            <span className="w-2 h-2 rounded-full bg-apex-indigo animate-pulse" />
            Now in Beta
          </div>
          <h1 className="text-5xl md:text-6xl font-bold tracking-tight mb-6">
            Deploy AI Agents
            <br />
            <span className="text-apex-indigo-light">That Actually Work</span>
          </h1>
          <p className="text-xl text-apex-muted max-w-2xl mx-auto mb-12">
            Autonomous AI teams for Sales, Marketing, and Operations.
            Configure once. Deploy in minutes. Scale without hiring.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/signup" className="btn-primary text-lg px-8 py-3">
              Start Free Trial
            </Link>
            <Link href="#pricing" className="btn-secondary text-lg px-8 py-3">
              View Pricing
            </Link>
          </div>
        </section>

        {/* Stats */}
        <section className="border-y border-apex-border bg-apex-surface/50">
          <div className="max-w-7xl mx-auto px-6 py-12 grid grid-cols-3 gap-8 text-center">
            <div>
              <p className="text-3xl font-bold text-apex-indigo-light">14</p>
              <p className="text-apex-muted mt-1">AI Agent Templates</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-apex-indigo-light">$2.7M</p>
              <p className="text-apex-muted mt-1">Pipeline Generated</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-apex-indigo-light">17 days</p>
              <p className="text-apex-muted mt-1">Average Time to Value</p>
            </div>
          </div>
        </section>

        {/* Domains */}
        <section className="max-w-7xl mx-auto px-6 py-24">
          <h2 className="text-3xl font-bold text-center mb-16">Three Domains. Infinite Possibilities.</h2>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                title: "Sales",
                desc: "SDR agents that research, qualify, and outreach to prospects on autopilot.",
                icon: "💰",
              },
              {
                title: "Marketing",
                desc: "Content writers and social managers that maintain your brand presence 24/7.",
                icon: "📢",
              },
              {
                title: "Operations",
                desc: "Inbox monitors, reporters, and workflow automators that keep things moving.",
                icon: "⚙️",
              },
            ].map((domain) => (
              <div key={domain.title} className="card hover:border-apex-indigo/30 transition-colors">
                <div className="text-4xl mb-4">{domain.icon}</div>
                <h3 className="text-xl font-semibold mb-2">{domain.title}</h3>
                <p className="text-apex-muted">{domain.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="max-w-7xl mx-auto px-6 py-24">
          <h2 className="text-3xl font-bold text-center mb-4">Simple, Transparent Pricing</h2>
          <p className="text-apex-muted text-center mb-16">Start free. Scale when ready.</p>
          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {[
              {
                name: "Starter",
                price: "$49",
                desc: "For small teams getting started",
                features: ["1-2 AI agents", "1 domain (Sales OR Marketing OR Ops)", "Pre-built templates", "Community support"],
              },
              {
                name: "Growth",
                price: "$149",
                desc: "For growing teams",
                features: ["5-8 AI agents", "Multi-domain access", "Custom workflows", "Advanced integrations", "Priority support", "Analytics dashboard"],
                popular: true,
              },
              {
                name: "Enterprise",
                price: "Custom",
                desc: "For organizations at scale",
                features: ["Unlimited agents", "All domains + custom", "Dedicated infrastructure", "White-glove onboarding", "SLA guarantees", "SSO"],
              },
            ].map((plan) => (
              <div
                key={plan.name}
                className={`card relative ${
                  "popular" in plan && plan.popular
                    ? "border-apex-indigo ring-1 ring-apex-indigo"
                    : ""
                }`}
              >
                {"popular" in plan && plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-apex-indigo rounded-full text-xs font-medium">
                    Most Popular
                  </div>
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
                      <span className="text-apex-indigo-light">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/signup"
                  className={`mt-8 block text-center py-2.5 rounded-lg font-medium text-sm ${
                    "popular" in plan && plan.popular ? "btn-primary" : "btn-secondary"
                  }`}
                >
                  {plan.price === "Custom" ? "Contact Sales" : "Start Free Trial"}
                </Link>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-apex-border">
        <div className="max-w-7xl mx-auto px-6 py-8 text-center text-apex-muted text-sm">
          © 2026 Kloudedge Apex LLP. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
