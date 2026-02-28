"use client";

import { useEffect, useRef, useState } from "react";

const oldVsNew = [
  {
    old: { text: "Hire an SDR: $60K/yr + 3 months to ramp", icon: "👤" },
    new: { text: "SDR Agent: $49/mo, deployed in 5 min, never calls in sick", icon: "🤖" },
  },
  {
    old: { text: "Content writer: $50K/yr + brand training", icon: "✏️" },
    new: { text: "Content Agent: writes 3x more, always on brand", icon: "⚡" },
  },
  {
    old: { text: "Manual CRM updates: 2 hours/day of data entry", icon: "📋" },
    new: { text: "CRM Sync Agent: real-time, zero manual entry", icon: "🔄" },
  },
  {
    old: { text: "Email follow-ups: balls dropped constantly", icon: "📭" },
    new: { text: "Inbox Monitor: zero-miss follow-ups, auto-triaged", icon: "📬" },
  },
  {
    old: { text: "Reports: days of spreadsheet wrangling", icon: "📊" },
    new: { text: "Reporting Agent: real-time dashboards, always fresh", icon: "📈" },
  },
];

const competitors = [
  { feature: "Multi-domain agents", apex: true, eleven: false, artisan: false },
  { feature: "Real tool use (APIs, search, email)", apex: true, eleven: false, artisan: "Partial" },
  { feature: "Persistent agent memory", apex: true, eleven: false, artisan: false },
  { feature: "Multi-step execution", apex: true, eleven: false, artisan: false },
  { feature: "Self-serve (no sales call)", apex: true, eleven: false, artisan: true },
  { feature: "Starting price", apex: "$49/mo", eleven: "$5K/mo", artisan: "$900/mo" },
];

function AnimatedRow({ children, delay }: { children: React.ReactNode; delay: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => setVisible(true), delay);
          observer.unobserve(el);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [delay]);

  return (
    <div
      ref={ref}
      className={`transition-all duration-600 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
      }`}
    >
      {children}
    </div>
  );
}

function Cell({ value }: { value: boolean | string }) {
  if (typeof value === "string") {
    return <span className="text-sm font-medium">{value}</span>;
  }
  return value ? (
    <span className="text-green-400 text-lg">✓</span>
  ) : (
    <span className="text-red-400/60 text-lg">✗</span>
  );
}

export function OldVsNewComparison() {
  return (
    <div className="space-y-4">
      {oldVsNew.map((row, i) => (
        <AnimatedRow key={i} delay={i * 100}>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="flex items-start gap-3 p-4 rounded-lg bg-red-500/5 border border-red-500/10">
              <span className="text-lg">{row.old.icon}</span>
              <span className="text-sm text-red-400/80">{row.old.text}</span>
            </div>
            <div className="flex items-start gap-3 p-4 rounded-lg bg-green-500/5 border border-green-500/10">
              <span className="text-lg">{row.new.icon}</span>
              <span className="text-sm text-green-400">{row.new.text}</span>
            </div>
          </div>
        </AnimatedRow>
      ))}
    </div>
  );
}

export function CompetitorTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-apex-border">
            <th className="text-left py-4 px-4 text-sm font-medium text-apex-muted">Feature</th>
            <th className="text-center py-4 px-4 text-sm font-medium text-apex-muted">11x.ai</th>
            <th className="text-center py-4 px-4 text-sm font-medium text-apex-muted">Artisan</th>
            <th className="text-center py-4 px-4 text-sm font-medium text-apex-indigo-light bg-apex-indigo/5 rounded-t-lg">Apex</th>
          </tr>
        </thead>
        <tbody>
          {competitors.map((row, i) => (
            <tr key={i} className="border-b border-apex-border/50">
              <td className="py-3.5 px-4 text-sm">{row.feature}</td>
              <td className="py-3.5 px-4 text-center"><Cell value={row.eleven} /></td>
              <td className="py-3.5 px-4 text-center"><Cell value={row.artisan} /></td>
              <td className="py-3.5 px-4 text-center bg-apex-indigo/5"><Cell value={row.apex} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
