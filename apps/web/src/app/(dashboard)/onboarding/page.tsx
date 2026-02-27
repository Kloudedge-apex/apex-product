"use client";

import { useState } from "react";
import { Building2, Target, Bot, Zap, Settings, Rocket } from "lucide-react";
import { cn } from "@/lib/cn";

const steps = [
  { label: "Organization", icon: Building2 },
  { label: "Domain", icon: Target },
  { label: "Template", icon: Bot },
  { label: "Integrations", icon: Zap },
  { label: "Configure", icon: Settings },
  { label: "Deploy", icon: Rocket },
];

const domains = [
  {
    id: "SALES",
    name: "Sales",
    desc: "SDR agents, CRM sync, reply handling",
    icon: "💰",
  },
  {
    id: "MARKETING",
    name: "Marketing",
    desc: "Content writing, social engagement, SEO",
    icon: "📢",
  },
  {
    id: "OPS",
    name: "Operations",
    desc: "Inbox monitoring, reporting, workflow automation",
    icon: "⚙️",
  },
];

export default function OnboardingPage() {
  const [currentStep, setCurrentStep] = useState(0);

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Set Up Your AI Workforce</h1>
        <p className="text-apex-muted mt-1">
          Follow these steps to deploy your first agent
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center gap-2 mb-12 overflow-x-auto pb-2">
        {steps.map((step, i) => {
          const Icon = step.icon;
          return (
            <button
              key={step.label}
              onClick={() => setCurrentStep(i)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors",
                i === currentStep
                  ? "bg-apex-indigo text-white"
                  : i < currentStep
                    ? "bg-apex-indigo/10 text-apex-indigo-light"
                    : "bg-apex-surface text-apex-muted"
              )}
            >
              <Icon size={16} />
              {step.label}
            </button>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="card">
        {currentStep === 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Organization Details</h2>
            <div>
              <label className="block text-sm text-apex-muted mb-1">
                Company Name
              </label>
              <input
                type="text"
                placeholder="Acme Inc."
                className="input-field w-full"
              />
            </div>
            <div>
              <label className="block text-sm text-apex-muted mb-1">
                Industry
              </label>
              <input
                type="text"
                placeholder="SaaS, E-commerce, etc."
                className="input-field w-full"
              />
            </div>
            <div>
              <label className="block text-sm text-apex-muted mb-1">
                Team Size
              </label>
              <select className="input-field w-full">
                <option>1-10</option>
                <option>11-50</option>
                <option>51-200</option>
                <option>200+</option>
              </select>
            </div>
          </div>
        )}

        {currentStep === 1 && (
          <div>
            <h2 className="text-lg font-semibold mb-4">Select Your Domain</h2>
            <div className="grid gap-4">
              {domains.map((domain) => (
                <button
                  key={domain.id}
                  className="card hover:border-apex-indigo/50 text-left transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <span className="text-3xl">{domain.icon}</span>
                    <div>
                      <p className="font-semibold">{domain.name}</p>
                      <p className="text-sm text-apex-muted">{domain.desc}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {currentStep === 2 && (
          <div>
            <h2 className="text-lg font-semibold mb-4">
              Choose an Agent Template
            </h2>
            <p className="text-apex-muted mb-4">
              Select a pre-built template to get started quickly.
            </p>
            <div className="space-y-3">
              <div className="card hover:border-apex-indigo/50 cursor-pointer transition-colors">
                <p className="font-semibold">SDR Agent</p>
                <p className="text-sm text-apex-muted">
                  Research leads, score against ICP, write personalized outreach
                </p>
              </div>
              <div className="card hover:border-apex-indigo/50 cursor-pointer transition-colors">
                <p className="font-semibold">CRM Sync Agent</p>
                <p className="text-sm text-apex-muted">
                  Auto-log interactions, update pipeline, track deals
                </p>
              </div>
            </div>
          </div>
        )}

        {currentStep === 3 && (
          <div>
            <h2 className="text-lg font-semibold mb-4">
              Connect Integrations
            </h2>
            <p className="text-apex-muted mb-4">
              Connect the tools your agent needs to work.
            </p>
            <div className="space-y-3">
              {["Gmail", "HubSpot", "LinkedIn"].map((name) => (
                <div
                  key={name}
                  className="flex items-center justify-between p-4 bg-apex-surface rounded-lg border border-apex-border"
                >
                  <span className="font-medium">{name}</span>
                  <button className="btn-secondary text-sm px-3 py-1.5">
                    Connect
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {currentStep === 4 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Configure Your Agent</h2>
            <div>
              <label className="block text-sm text-apex-muted mb-1">
                Agent Name
              </label>
              <input
                type="text"
                placeholder="My SDR Agent"
                className="input-field w-full"
              />
            </div>
            <div>
              <label className="block text-sm text-apex-muted mb-1">
                Email Tone
              </label>
              <select className="input-field w-full">
                <option>Professional</option>
                <option>Casual</option>
                <option>Direct</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-apex-muted mb-1">
                Daily Email Limit
              </label>
              <input
                type="number"
                placeholder="50"
                className="input-field w-full"
              />
            </div>
          </div>
        )}

        {currentStep === 5 && (
          <div className="text-center py-8">
            <Rocket size={48} className="mx-auto text-apex-indigo mb-4" />
            <h2 className="text-xl font-semibold mb-2">Ready to Deploy!</h2>
            <p className="text-apex-muted mb-6">
              Your agent is configured and ready to go. Click deploy to
              start it.
            </p>
            <button className="btn-primary text-lg px-8 py-3">
              Deploy Agent
            </button>
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between mt-6">
        <button
          onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
          className="btn-secondary"
          disabled={currentStep === 0}
        >
          Previous
        </button>
        <button
          onClick={() =>
            setCurrentStep(Math.min(steps.length - 1, currentStep + 1))
          }
          className="btn-primary"
          disabled={currentStep === steps.length - 1}
        >
          Next
        </button>
      </div>
    </div>
  );
}
