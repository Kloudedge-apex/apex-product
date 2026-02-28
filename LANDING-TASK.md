# LANDING PAGE REWRITE TASK

## Context
Current landing page is a generic SaaS template. It needs to feel premium, show the product in action, and clearly differentiate Apex from competitors like 11x.ai, Relevance AI, and Artisan AI.

## The Problem with Current Page
- Generic stats ("6 templates", "14 agents deployed") — doesn't inspire confidence
- No product screenshots or visual demos
- "How It Works" section is forgettable
- Agent showcase is just text cards
- No social proof (logos, testimonials, case studies)
- No competitive differentiation
- Pricing is there but doesn't anchor value

## Design Direction
- Premium dark theme (keep apex-* classes)
- More visual: animated elements, gradient accents, visual demonstrations
- Show the product working — not just describe it
- Clear narrative: problem → solution → proof → pricing → CTA
- Competitive: "not just another AI SDR tool"

## NEW PAGE STRUCTURE

### 1. Hero Section (IMPACT)
Replace generic hero with a split layout:

**Left side (text):**
- Badge: "Trusted by 10+ teams in beta" (or similar)
- H1: "Your AI Workforce. Deployed in 5 Minutes." (shorter, punchier)
- Subhead: "Autonomous agents that research, email, post, report, and sync — while you focus on closing deals."
- Two CTAs: "Start Free Trial" (primary) + "Watch Demo" (secondary, links to #demo)

**Right side (visual):**
A simulated terminal/command center showing an agent running in real time:
```
┌─────────────────────────────────────────┐
│  ● SDR Agent — Running                  │
│                                         │
│  [✓] Researching Acme Corp...          │
│  [✓] Lead score: 87/100               │
│  [✓] Drafting personalized email...    │
│  [✓] Email sent to cto@acme.com       │
│  [✓] HubSpot updated: new deal $45K   │
│                                         │
│  Completed in 4.2s · 612 tokens · $0.003│
└─────────────────────────────────────────┘
```

Build this as a CSS-animated component with typing effect. Steps appear one by one with a 600ms delay. Use monospace font, green checkmarks animating in, subtle glow on the container. Make it feel like watching a real agent work.

Implementation:
```tsx
"use client";
function AgentDemo() {
  const [visibleSteps, setVisibleSteps] = useState(0);
  
  useEffect(() => {
    const interval = setInterval(() => {
      setVisibleSteps(prev => prev < 5 ? prev + 1 : prev);
    }, 800);
    return () => clearInterval(interval);
  }, []);

  const steps = [
    { icon: "🔍", text: "Researching Acme Corp...", color: "text-blue-400" },
    { icon: "📊", text: "Lead score: 87/100 — High priority", color: "text-green-400" },
    { icon: "✉️", text: "Drafting personalized email...", color: "text-yellow-400" },
    { icon: "✅", text: "Email sent to cto@acme.com", color: "text-green-400" },
    { icon: "📋", text: "HubSpot updated: New deal $45,000", color: "text-cyan-400" },
  ];
  // Render with opacity/translate transitions
}
```

### 2. Logo Bar / Social Proof
A subtle row below the hero:
- "Built by the team behind Kloudedge" (or "Backed by" if applicable)
- Tech stack logos (subtle, grayscale): OpenAI, Azure, HubSpot, Gmail, Outlook
- These aren't customers — they're integrations/partners. Label accordingly: "Integrates with"

### 3. Problem Section — "The Old Way vs The Apex Way"

Two-column comparison table:

**The Old Way** (red/muted tones):
- Hire an SDR: $60K/yr salary + 3 months to ramp
- Hire a content writer: $50K/yr + brand training
- Manual CRM updates: 2 hours/day of data entry
- Email follow-ups: balls dropped constantly
- Reports: days of spreadsheet wrangling

**The Apex Way** (green/indigo tones):
- SDR Agent: $49/mo, deployed in 5 minutes, never calls in sick
- Content Writer Agent: writes 3x more, always on brand
- CRM Sync Agent: real-time, zero manual entry
- Inbox Monitor: zero-miss follow-ups, auto-triaged
- Reporting Agent: real-time dashboards, always fresh

Use a visually striking comparison layout. Each row animated on scroll (simple CSS intersection observer, no library).

### 4. Agent Showcase — Interactive Demo Section

Instead of static cards, make an interactive tabbed showcase:

**Tab bar:** SDR Agent | Content Writer | Inbox Monitor | CRM Sync | Social | Reporting

Each tab shows a **simulated agent run** in a fake terminal window:
- The "agent" executes steps with realistic-looking output
- Show tool calls: `→ web_search("Acme Corp latest funding")` with results
- Show the final output (email draft, content piece, triage report, etc.)
- Each tab has its own animation sequence

Below the terminal: a card showing "What this agent does" with 3-4 bullet points and a metric: "Avg. 23% response rate" or "Processes 100+ emails/day"

### 5. "How It Works" — Visual Timeline

Replace the boring 4-step grid with a vertical timeline:

```
  ①  Sign Up (30 seconds)
  │   "Create your account — no credit card, no sales call."
  │
  ②  Pick Your Agent
  │   "Choose from 6 battle-tested templates. SDR, Content, CRM..."
  │   [Mini screenshot of template picker]
  │
  ③  Connect Your Tools
  │   "One-click OAuth for Gmail, Outlook, HubSpot."
  │   [Integration icons: Gmail, Outlook, HubSpot]
  │
  ④  Deploy & Watch
      "Hit deploy. Your agent starts working immediately."
      "You get a real-time dashboard showing every step, every tool call, every result."
```

Use a vertical line connecting the steps. Each step fades in on scroll. Alternate left/right for desktop.

### 6. Competitive Differentiation — "Not Just Another AI SDR"

A section that directly addresses why Apex is different:

```
┌─────────────────────────────────────────────────────┐
│  Feature           │ 11x.ai  │ Artisan │ Apex     │
│────────────────────┼─────────┼─────────┼──────────│
│  Multi-domain      │  ✗      │  ✗      │  ✓       │
│  Real tool use     │  ✗      │  Partial│  ✓       │
│  Agent memory      │  ✗      │  ✗      │  ✓       │
│  Multi-step exec   │  ✗      │  ✗      │  ✓       │
│  Self-serve        │  ✗      │  ✓      │  ✓       │
│  Starting price    │ $5K/mo  │ $900/mo │ $49/mo   │
└─────────────────────────────────────────────────────┘
```

Build this as an actual comparison table, not a boring feature grid. Make the Apex column highlighted with indigo background.

Below: "Other tools give you a single-purpose chatbot for $5,000/month. Apex gives you a full AI workforce with real tool use, persistent memory, and multi-step execution — starting at $49/month."

### 7. Pricing Section (Enhanced)

Keep 3 tiers but improve:
- Add annual pricing toggle (20% discount)
- Each tier: clear agent count, token limits, integrations
- Growth tier: add "Recommended for most teams" badge
- Enterprise: "Talk to us" with Calendly link or contact form
- Below pricing: "All plans include: 3-day free trial, no credit card required, cancel anytime"

### 8. Testimonials / Trust Section

Since we're in beta without real testimonials yet, use:
- "What beta testers are saying" with 2-3 quotes (can be real from Nikhil's network or placeholder)
- Or skip testimonials and use a "Built by practitioners" section: "We built Apex because we ran a 14-agent AI workforce ourselves. It's not theoretical — it's battle-tested."

### 9. Final CTA — Big, Bold

Full-width gradient section:
- "Deploy your first agent in 5 minutes"
- Email input + "Start Free Trial" button (just links to /signup actually)
- "No credit card required. Cancel anytime."

### 10. Footer (Enhanced)

Add:
- Social links (LinkedIn, X/Twitter)
- "Status" link (can be placeholder)
- "Documentation" link (can be placeholder)
- "Blog" link (placeholder)
- Copyright with Kloudedge Apex LLP

## Technical Requirements

1. The page must remain a **server component** for SEO (metadata export). Client interactivity (animations, tabs) should use `"use client"` components imported into the page.
2. Create separate component files for complex interactive pieces:
   - `apps/web/src/components/landing/AgentDemo.tsx` — the animated terminal
   - `apps/web/src/components/landing/AgentShowcase.tsx` — the tabbed showcase
   - `apps/web/src/components/landing/ComparisonTable.tsx` — old vs new + competitor table
   - `apps/web/src/components/landing/ScrollReveal.tsx` — simple scroll animation wrapper
3. **No animation libraries**. Use CSS transitions + Intersection Observer for scroll reveals.
4. **All CSS via Tailwind** — no custom CSS files.
5. **Mobile responsive** — everything must look good on mobile.
6. **Keep existing SEO** (metadata, JSON-LD) and enhance it.
7. Build must pass.
8. Single commit: "Landing page rewrite — premium design with interactive demos"

## GO. Make it sell.
