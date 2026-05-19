"use client";

import Link from "next/link";
import { useState } from "react";

const plans = [
  {
    name: "Sales Engine",
    monthlyPrice: 499,
    desc: "AI-powered sales pipeline automation",
    features: [
      "SDR Agent (lead research + qualification)",
      "Account Executive Agent (follow-ups)",
      "Sales Copywriter Agent",
      "CRM integration (HubSpot, Pipedrive)",
      "Email sequences + personalization",
      "Pipeline analytics dashboard",
    ],
    cta: "Start Free Trial",
    popular: false,
    link: "https://rzp.io/rzp/tiWRdYCd",
  },
  {
    name: "Full Stack",
    monthlyPrice: 899,
    desc: "Sales + Marketing + Ops in one platform",
    badge: "Best Value",
    features: [
      "All Sales Engine agents",
      "All Marketing Engine agents",
      "DevOps + Monitoring agents",
      "Custom workflow builder",
      "Multi-domain orchestration",
      "Priority support + onboarding",
      "Dedicated Slack channel",
    ],
    cta: "Start Free Trial",
    popular: true,
    link: "https://rzp.io/rzp/xqQ53Ta",
  },
  {
    name: "Marketing Engine",
    monthlyPrice: 499,
    desc: "Content, social, and growth on autopilot",
    features: [
      "Content Writer Agent (blogs, threads)",
      "Social Media Agents (X, LinkedIn)",
      "SEO + trend monitoring",
      "Newsletter automation",
      "Analytics + performance tracking",
      "Brand voice consistency",
    ],
    cta: "Start Free Trial",
    popular: false,
    link: "https://rzp.io/rzp/ZbnLL7h2",
  },
];

export function PricingSection() {
  return (
    <div>
      {/* Cards */}
      <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
        {plans.map((plan) => (
          <div
            key={plan.name}
            className={`card relative ${
              plan.popular
                ? "border-apex-indigo ring-1 ring-apex-indigo"
                : ""
            }`}
          >
            {plan.badge && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-apex-indigo rounded-full text-xs font-medium whitespace-nowrap">
                {plan.badge}
              </div>
            )}
            <h3 className="text-lg font-semibold">{plan.name}</h3>
            <p className="text-3xl font-bold mt-2">
              ${plan.monthlyPrice}
              <span className="text-lg text-apex-muted font-normal">/mo</span>
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
            <a
              href={plan.link}
              target="_blank"
              rel="noopener noreferrer"
              className={`mt-8 block text-center py-2.5 rounded-lg font-medium text-sm ${
                plan.popular ? "btn-primary" : "btn-secondary"
              }`}
            >
              {plan.cta}
            </a>
          </div>
        ))}
      </div>

      {/* Custom / Enterprise */}
      <div className="mt-8 text-center">
        <p className="text-apex-muted text-sm">
          Need a custom setup?{" "}
          <a
            href="mailto:kestrel@kloudedge.co"
            className="text-apex-indigo-light hover:text-white transition-colors font-medium"
          >
            Talk to us about a custom plan
          </a>
        </p>
      </div>
    </div>
  );
}
