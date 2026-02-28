"use client";

import { useEffect, useState } from "react";

const steps = [
  { icon: "🔍", text: "Researching Acme Corp...", detail: "Found: Series B, $12M raised, 85 employees", color: "text-blue-400" },
  { icon: "📊", text: "Lead score: 87/100 — High priority", detail: "Decision maker: Sarah Chen, CTO", color: "text-green-400" },
  { icon: "✉️", text: "Drafting personalized email...", detail: "Subject: Re: scaling your engineering team", color: "text-yellow-400" },
  { icon: "✅", text: "Email sent to cto@acme.com", detail: "Personalized with 3 mutual connections", color: "text-green-400" },
  { icon: "📋", text: "HubSpot updated: New deal $45,000", detail: "Stage: Qualified → Pipeline", color: "text-cyan-400" },
];

export function AgentDemo() {
  const [visibleSteps, setVisibleSteps] = useState(0);
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    if (visibleSteps < steps.length) {
      const timer = setTimeout(
        () => setVisibleSteps((prev) => prev + 1),
        800
      );
      return () => clearTimeout(timer);
    } else {
      const timer = setTimeout(() => setIsComplete(true), 400);
      return () => clearTimeout(timer);
    }
  }, [visibleSteps]);

  return (
    <div className="relative">
      {/* Glow effect */}
      <div className="absolute -inset-1 bg-gradient-to-r from-apex-indigo/20 via-purple-500/10 to-cyan-500/20 rounded-2xl blur-xl" />

      <div className="relative bg-apex-navy-dark border border-apex-border rounded-xl overflow-hidden shadow-2xl">
        {/* Terminal header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-apex-border bg-apex-surface/50">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/80" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
            <div className="w-3 h-3 rounded-full bg-green-500/80" />
          </div>
          <div className="flex-1 text-center">
            <span className="text-xs text-apex-muted font-mono">
              SDR Agent — <span className="text-green-400">Running</span>
            </span>
          </div>
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
        </div>

        {/* Terminal body */}
        <div className="p-5 font-mono text-sm space-y-3 min-h-[280px]">
          {steps.map((step, i) => (
            <div
              key={i}
              className={`transition-all duration-500 ${
                i < visibleSteps
                  ? "opacity-100 translate-y-0"
                  : "opacity-0 translate-y-4"
              }`}
            >
              <div className="flex items-start gap-3">
                <span className={`${i < visibleSteps ? "opacity-100" : "opacity-0"} transition-opacity duration-300`}>
                  {step.icon}
                </span>
                <div>
                  <span className={step.color}>{step.text}</span>
                  {i < visibleSteps && (
                    <p className="text-apex-muted text-xs mt-0.5">{step.detail}</p>
                  )}
                </div>
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {visibleSteps < steps.length && visibleSteps > 0 && (
            <div className="flex items-center gap-1 pl-8 text-apex-muted">
              <span className="animate-pulse">●</span>
              <span className="animate-pulse" style={{ animationDelay: "200ms" }}>●</span>
              <span className="animate-pulse" style={{ animationDelay: "400ms" }}>●</span>
            </div>
          )}
        </div>

        {/* Footer stats */}
        <div
          className={`px-5 py-3 border-t border-apex-border bg-apex-surface/30 flex items-center justify-between text-xs font-mono transition-opacity duration-500 ${
            isComplete ? "opacity-100" : "opacity-0"
          }`}
        >
          <span className="text-green-400">✓ Completed in 4.2s</span>
          <span className="text-apex-muted">612 tokens · $0.003</span>
        </div>
      </div>
    </div>
  );
}
