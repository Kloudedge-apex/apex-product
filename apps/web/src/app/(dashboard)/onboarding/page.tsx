"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { Building2, Target, Bot, Zap, Settings, Rocket, Loader2, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";

const steps = [
  { label: "Organization", icon: Building2 },
  { label: "Domain", icon: Target },
  { label: "Template", icon: Bot },
  { label: "Integrations", icon: Zap },
  { label: "Configure", icon: Settings },
  { label: "Deploy", icon: Rocket },
];

const domains = [
  { id: "SALES", name: "Sales", desc: "SDR agents, CRM sync, reply handling", icon: "💰" },
  { id: "MARKETING", name: "Marketing", desc: "Content writing, social engagement, SEO", icon: "📢" },
  { id: "OPS", name: "Operations", desc: "Inbox monitoring, reporting, workflow automation", icon: "⚙️" },
];

interface Template {
  id: string;
  name: string;
  description: string;
  domain: string;
}

export default function OnboardingPage() {
  const { user } = useUser();
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployed, setDeployed] = useState(false);

  // Form state
  const [orgName, setOrgName] = useState("");
  const [industry, setIndustry] = useState("");
  const [teamSize, setTeamSize] = useState("1-10");
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [emailTone, setEmailTone] = useState("Professional");
  const [dailyLimit, setDailyLimit] = useState("50");

  // Load templates
  useEffect(() => {
    api.agents.templates().then((t) => {
      if (Array.isArray(t)) setTemplates(t);
    }).catch(() => {});
  }, []);

  // Filter templates by domain
  const filteredTemplates = selectedDomain
    ? templates.filter((t) => t.domain === selectedDomain)
    : templates;

  // Auto-set agent name from template
  useEffect(() => {
    if (selectedTemplate && !agentName) {
      const tmpl = templates.find((t) => t.id === selectedTemplate);
      if (tmpl) setAgentName(`My ${tmpl.name}`);
    }
  }, [selectedTemplate, templates, agentName]);

  async function handleDeploy() {
    if (!user?.id) return;
    setDeploying(true);
    try {
      // 1. Create org (or get existing)
      let org = await api.orgs.getByClerkUser(user.id).catch(() => null);
      if (!org) {
        const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
        org = await api.orgs.create({
          name: orgName,
          slug: slug || "my-org",
          clerkUserId: user.id,
          email: user.emailAddresses?.[0]?.emailAddress || "",
          userName: user.firstName || undefined,
        });
      }

      // 2. Create agent
      if (org?.id && selectedTemplate && selectedDomain) {
        await api.agents.create({
          orgId: org.id,
          templateId: selectedTemplate,
          name: agentName || "My Agent",
          domain: selectedDomain,
          config: {
            emailTone,
            dailyLimit: parseInt(dailyLimit) || 50,
            industry,
            teamSize,
          },
        });
      }

      setDeployed(true);
      setTimeout(() => router.push("/agents"), 2000);
    } catch (err) {
      console.error("Deploy failed:", err);
    } finally {
      setDeploying(false);
    }
  }

  function canGoNext(): boolean {
    switch (currentStep) {
      case 0: return orgName.trim().length > 0;
      case 1: return selectedDomain !== null;
      case 2: return selectedTemplate !== null;
      case 3: return true; // integrations are optional
      case 4: return agentName.trim().length > 0;
      default: return true;
    }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Set Up Your AI Workforce</h1>
        <p className="text-apex-muted mt-1">Follow these steps to deploy your first agent</p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center gap-2 mb-12 overflow-x-auto pb-2">
        {steps.map((step, i) => {
          const Icon = step.icon;
          return (
            <button
              key={step.label}
              onClick={() => i < currentStep && setCurrentStep(i)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors",
                i === currentStep ? "bg-apex-indigo text-white" :
                i < currentStep ? "bg-apex-indigo/10 text-apex-indigo-light cursor-pointer" :
                "bg-apex-surface text-apex-muted cursor-not-allowed"
              )}
            >
              {i < currentStep ? <Check size={16} /> : <Icon size={16} />}
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
              <label className="block text-sm text-apex-muted mb-1">Company Name *</label>
              <input type="text" placeholder="Acme Inc." className="input-field w-full"
                value={orgName} onChange={(e) => setOrgName(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm text-apex-muted mb-1">Industry</label>
              <input type="text" placeholder="SaaS, E-commerce, etc." className="input-field w-full"
                value={industry} onChange={(e) => setIndustry(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm text-apex-muted mb-1">Team Size</label>
              <select className="input-field w-full" value={teamSize} onChange={(e) => setTeamSize(e.target.value)}>
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
                  onClick={() => setSelectedDomain(domain.id)}
                  className={cn(
                    "card text-left transition-colors",
                    selectedDomain === domain.id
                      ? "border-apex-indigo bg-apex-indigo/5"
                      : "hover:border-apex-indigo/50"
                  )}
                >
                  <div className="flex items-center gap-4">
                    <span className="text-3xl">{domain.icon}</span>
                    <div>
                      <p className="font-semibold">{domain.name}</p>
                      <p className="text-sm text-apex-muted">{domain.desc}</p>
                    </div>
                    {selectedDomain === domain.id && (
                      <Check size={20} className="text-apex-indigo ml-auto" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {currentStep === 2 && (
          <div>
            <h2 className="text-lg font-semibold mb-4">Choose an Agent Template</h2>
            <p className="text-apex-muted mb-4">
              {filteredTemplates.length} template{filteredTemplates.length !== 1 ? "s" : ""} available for {selectedDomain}
            </p>
            {loading ? (
              <div className="text-center py-8"><Loader2 className="animate-spin text-apex-indigo mx-auto" size={24} /></div>
            ) : (
              <div className="space-y-3">
                {filteredTemplates.map((tmpl) => (
                  <button
                    key={tmpl.id}
                    onClick={() => setSelectedTemplate(tmpl.id)}
                    className={cn(
                      "card w-full text-left cursor-pointer transition-colors",
                      selectedTemplate === tmpl.id
                        ? "border-apex-indigo bg-apex-indigo/5"
                        : "hover:border-apex-indigo/50"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold">{tmpl.name}</p>
                        <p className="text-sm text-apex-muted">{tmpl.description}</p>
                      </div>
                      {selectedTemplate === tmpl.id && (
                        <Check size={20} className="text-apex-indigo" />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {currentStep === 3 && (
          <div>
            <h2 className="text-lg font-semibold mb-4">Connect Integrations</h2>
            <p className="text-apex-muted mb-4">Connect the tools your agent needs. You can do this later.</p>
            <div className="space-y-3">
              {["Gmail", "HubSpot", "LinkedIn", "Slack"].map((name) => (
                <div key={name} className="flex items-center justify-between p-4 bg-apex-surface rounded-lg border border-apex-border">
                  <span className="font-medium">{name}</span>
                  <button className="btn-secondary text-sm px-3 py-1.5">Connect</button>
                </div>
              ))}
            </div>
            <p className="text-xs text-apex-muted mt-4">OAuth integrations coming soon. Skip for now.</p>
          </div>
        )}

        {currentStep === 4 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Configure Your Agent</h2>
            <div>
              <label className="block text-sm text-apex-muted mb-1">Agent Name *</label>
              <input type="text" placeholder="My SDR Agent" className="input-field w-full"
                value={agentName} onChange={(e) => setAgentName(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm text-apex-muted mb-1">Email Tone</label>
              <select className="input-field w-full" value={emailTone} onChange={(e) => setEmailTone(e.target.value)}>
                <option>Professional</option>
                <option>Casual</option>
                <option>Direct</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-apex-muted mb-1">Daily Action Limit</label>
              <input type="number" placeholder="50" className="input-field w-full"
                value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
            </div>
          </div>
        )}

        {currentStep === 5 && (
          <div className="text-center py-8">
            {deployed ? (
              <>
                <Check size={48} className="mx-auto text-green-400 mb-4" />
                <h2 className="text-xl font-semibold mb-2">Agent Deployed!</h2>
                <p className="text-apex-muted">Redirecting to your agents...</p>
              </>
            ) : (
              <>
                <Rocket size={48} className="mx-auto text-apex-indigo mb-4" />
                <h2 className="text-xl font-semibold mb-2">Ready to Deploy!</h2>
                <div className="text-left max-w-sm mx-auto mb-6 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-apex-muted">Organization</span>
                    <span className="font-medium">{orgName}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-apex-muted">Domain</span>
                    <span className="font-medium">{selectedDomain}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-apex-muted">Template</span>
                    <span className="font-medium">{templates.find((t) => t.id === selectedTemplate)?.name}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-apex-muted">Agent Name</span>
                    <span className="font-medium">{agentName}</span>
                  </div>
                </div>
                <button
                  onClick={handleDeploy}
                  disabled={deploying}
                  className="btn-primary text-lg px-8 py-3 inline-flex items-center gap-2"
                >
                  {deploying ? <Loader2 size={18} className="animate-spin" /> : <Rocket size={18} />}
                  {deploying ? "Deploying..." : "Deploy Agent"}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Navigation */}
      {currentStep < 5 || !deployed ? (
        <div className="flex items-center justify-between mt-6">
          <button
            onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
            className="btn-secondary"
            disabled={currentStep === 0}
          >
            Previous
          </button>
          {currentStep < 5 && (
            <button
              onClick={() => setCurrentStep(currentStep + 1)}
              className="btn-primary"
              disabled={!canGoNext()}
            >
              {currentStep === 4 ? "Review & Deploy" : "Next"}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
