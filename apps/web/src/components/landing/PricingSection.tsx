"use client";

import Link from "next/link";
import { useState } from "react";

const plans = [
  {
    name: "Starter",
    monthlyPrice: 49,
    desc: "For small teams getting started",
    features: [
      "1-2 AI agents",
      "1 domain (Sales OR Marketing OR Ops)",
      "Pre-built templates",
      "10K tokens/run",
      "Email support",
    ],
    cta: "Start Free Trial",
    popular: false,
    monthlyLink: "https://rzp.io/rzp/obCLnmhT",
    annualLink: "https://rzp.io/rzp/HH1JTnP",
  },
  {
    name: "Growth",
    monthlyPrice: 149,
    desc: "For growing teams",
    badge: "Recommended for most teams",
    features: [
      "5-8 AI agents",
      "Multi-domain access",
      "Custom workflows",
      "50K tokens/run",
      "Advanced integrations",
      "Priority support",
      "Analytics dashboard",
    ],
    cta: "Start Free Trial",
    popular: true,
    monthlyLink: "https://rzp.io/rzp/g1wWro4g",
    annualLink: "https://rzp.io/rzp/x3wPkqqy",
  },
  {
    name: "Enterprise",
    monthlyPrice: 0,
    desc: "For organizations at scale",
    features: [
      "Unlimited agents",
      "All domains + custom",
      "Unlimited tokens",
      "Dedicated infrastructure",
      "White-glove onboarding",
      "SLA guarantees",
      "SSO & SAML",
    ],
    cta: "Contact Sales",
    popular: false,
    monthlyLink: "mailto:kestrel@kloudedge.co",
    annualLink: "mailto:kestrel@kloudedge.co",
  },
];

export function PricingSection() {
  const [annual, setAnnual] = useState(false);

  return (
    <div>
      {/* Toggle */}
      <div className="flex items-center justify-center gap-3 mb-12">
        <span className={`text-sm ${!annual ? "text-white" : "text-apex-muted"}`}>Monthly</span>
        <button
          onClick={() => setAnnual(!annual)}
          className={`relative w-12 h-6 rounded-full transition-colors ${
            annual ? "bg-apex-indigo" : "bg-apex-slate"
          }`}
          aria-label="Toggle annual pricing"
        >
          <div
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              annual ? "translate-x-6" : "translate-x-0"
            }`}
          />
        </button>
        <span className={`text-sm ${annual ? "text-white" : "text-apex-muted"}`}>
          Annual <span className="text-green-400 text-xs font-medium">Save 20%</span>
        </span>
      </div>

      {/* Cards */}
      <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
        {plans.map((plan) => {
          const isEnterprise = plan.monthlyPrice === 0;
          const price = annual
            ? Math.round(plan.monthlyPrice * 0.8)
            : plan.monthlyPrice;
          const paymentLink = annual ? plan.annualLink : plan.monthlyLink;

          return (
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
                {isEnterprise ? (
                  "Custom"
                ) : (
                  <>
                    ${price}
                    <span className="text-lg text-apex-muted font-normal">/mo</span>
                  </>
                )}
              </p>
              {!isEnterprise && annual && (
                <p className="text-xs text-green-400 mt-1">
                  ${price * 12}/yr (save ${(plan.monthlyPrice - price) * 12}/yr)
                </p>
              )}
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
                href={paymentLink}
                target={isEnterprise ? undefined : "_blank"}
                rel={isEnterprise ? undefined : "noopener noreferrer"}
                className={`mt-8 block text-center py-2.5 rounded-lg font-medium text-sm ${
                  plan.popular ? "btn-primary" : "btn-secondary"
                }`}
              >
                {plan.cta}
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
