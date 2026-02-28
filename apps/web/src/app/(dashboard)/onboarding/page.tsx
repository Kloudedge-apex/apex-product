"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { Building2, Target, Bot, Zap, Settings, Rocket, Loader2, Check, ArrowLeft } from "lucide-react";
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
  defaultConfig: Record<string, unknown>;
  requiredIntegrations: string[];
}

// Template-specific config schemas
const configSchemas: Record<string, Array<{ key: string; label: string; type: "text" | "textarea" | "select" | "number" | "tags"; options?: string[]; placeholder?: string }>> = {
  "sdr agent": [
    { key: "industry", label: "Target Industry", type: "text", placeholder: "SaaS, E-commerce, FinTech..." },
    { key: "companySize", label: "Target Company Size", type: "select", options: ["1-10", "11-50", "51-200", "201-1000", "1000+"] },
    { key: "geography", label: "Target Geography", type: "text", placeholder: "US, Europe, APAC..." },
    { key: "emailTone", label: "Email Tone", type: "select", options: ["Professional", "Casual", "Direct"] },
    { key: "followUpDays", label: "Follow-up Cadence (days)", type: "number", placeholder: "3" },
    { key: "dailyLimit", label: "Daily Email Limit", type: "number", placeholder: "50" },
  ],
  "crm sync agent": [
    { key: "syncFrequency", label: "Sync Frequency", type: "select", options: ["Real-time", "Hourly", "Daily"] },
    { key: "fieldsToSync", label: "Fields to Sync", type: "tags", placeholder: "contacts, deals, companies" },
  ],
  "content writer": [
    { key: "brandVoice", label: "Brand Voice", type: "textarea", placeholder: "Professional, insightful, data-driven..." },
    { key: "targetPlatforms", label: "Target Platforms", type: "tags", placeholder: "LinkedIn, Twitter, Blog" },
    { key: "contentThemes", label: "Content Themes", type: "tags", placeholder: "AI, Sales Tech, Growth" },
    { key: "postingSchedule", label: "Posting Schedule", type: "select", options: ["Daily", "3x/week", "Weekly"] },
  ],
  "social engagement agent": [
    { key: "keywords", label: "Keywords to Monitor", type: "tags", placeholder: "AI, automation, SaaS" },
    { key: "responseStyle", label: "Response Style", type: "select", options: ["Helpful", "Professional", "Casual", "Thought Leader"] },
    { key: "platforms", label: "Platforms", type: "tags", placeholder: "LinkedIn, Twitter" },
  ],
  "inbox monitor": [
    { key: "emailCategories", label: "Email Categories", type: "tags", placeholder: "urgent, follow-up, newsletter, spam" },
    { key: "autoReplyRules", label: "Auto-Reply Rules", type: "textarea", placeholder: "Auto-reply to meeting requests and urgent items" },
    { key: "priorityRules", label: "Priority Rules", type: "textarea", placeholder: "Prioritize by sender importance and deadline keywords" },
  ],
  "reporting agent": [
    { key: "reportType", label: "Report Type", type: "select", options: ["Daily", "Weekly", "Monthly"] },
    { key: "metricsToTrack", label: "Metrics to Track", type: "tags", placeholder: "emails sent, response rate, meetings booked" },
    { key: "deliveryMethod", label: "Delivery Method", type: "select", options: ["Dashboard", "Email", "Both"] },
  ],
};

export default function OnboardingPage() {
  const { user } = useUser();
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployed, setDeployed] = useState(false);
  const [existingOrg, setExistingOrg] = useState<{ id: string; name: string } | null>(null);

  // Form state
  const [orgName, setOrgName] = useState("");
  const [industry, setIndustry] = useState("");
  const [teamSize, setTeamSize] = useState("1-10");
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [agentConfig, setAgentConfig] = useState<Record<string, string>>({});
  const [connectedIntegrations, setConnectedIntegrations] = useState<Set<string>>(new Set());
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);

  // Load templates and check existing org
  useEffect(() => {
    api.agents.templates().then((t) => {
      if (Array.isArray(t)) setTemplates(t);
    }).catch(() => {});

    if (user?.id) {
      api.orgs.getByClerkUser(user.id).then((org) => {
        if (org?.id) {
          setExistingOrg({ id: org.id, name: org.name });
          setOrgName(org.name);
          // Load existing integrations
          api.integrations.list(org.id).then((integrations) => {
            if (Array.isArray(integrations)) {
              const providers = new Set(integrations.filter((i: { status: string }) => i.status === "CONNECTED").map((i: { provider: string }) => i.provider));
              setConnectedIntegrations(providers);
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  }, [user?.id]);

  const filteredTemplates = selectedDomain
    ? templates.filter((t) => t.domain === selectedDomain) : templates;

  const selectedTemplateObj = templates.find((t) => t.id === selectedTemplate);
  const templateConfigSchema = selectedTemplateObj ? configSchemas[selectedTemplateObj.name.toLowerCase()] || [] : [];
  const requiredIntegrations = selectedTemplateObj?.requiredIntegrations || [];

  useEffect(() => {
    if (selectedTemplate && !agentName) {
      const tmpl = templates.find((t) => t.id === selectedTemplate);
      if (tmpl) setAgentName(`My ${tmpl.name}`);
    }
  }, [selectedTemplate, templates, agentName]);

  async function handleConnectIntegration(provider: string) {
    if (!existingOrg && !orgName) return;
    setConnectingProvider(provider);
    try {
      let orgId = existingOrg?.id;
      if (!orgId && user?.id) {
        const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
        const newOrg = await api.orgs.create({
          name: orgName, slug: slug || "my-org",
          clerkUserId: user.id,
          email: user.emailAddresses?.[0]?.emailAddress || "",
          userName: user.firstName || undefined,
        });
        setExistingOrg({ id: newOrg.id, name: newOrg.name });
        orgId = newOrg.id;
      }
      if (orgId) {
        await api.integrations.connect(orgId, provider);
        setConnectedIntegrations((prev) => new Set([...prev, provider]));
      }
    } catch { /* */ }
    setConnectingProvider(null);
  }

  async function handleDeploy() {
    if (!user?.id) return;
    setDeploying(true);
    try {
      let orgId = existingOrg?.id;
      if (!orgId) {
        const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
        const org = await api.orgs.create({
          name: orgName, slug: slug || "my-org",
          clerkUserId: user.id,
          email: user.emailAddresses?.[0]?.emailAddress || "",
          userName: user.firstName || undefined,
        });
        orgId = org.id;
      }

      if (orgId && selectedTemplate && selectedDomain) {
        const agent = await api.agents.create({
          orgId, templateId: selectedTemplate,
          name: agentName || "My Agent", domain: selectedDomain,
          config: { ...agentConfig, industry, teamSize },
        });
        // Deploy immediately
        await api.agents.deploy(agent.id);
        // Trigger first run
        await api.runs.trigger(agent.id, orgId).catch(() => {});
      }

      setDeployed(true);
      setTimeout(() => router.push("/dashboard"), 2000);
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
      case 3: return true;
      case 4: return agentName.trim().length > 0;
      default: return true;
    }
  }

  function updateConfig(key: string, value: string) {
    setAgentConfig((prev) => ({ ...prev, [key]: value }));
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
            <button key={step.label} onClick={() => i < currentStep && setCurrentStep(i)}
              className={cn("flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors",
                i === currentStep ? "bg-apex-indigo text-white" :
                i < currentStep ? "bg-apex-indigo/10 text-apex-indigo-light cursor-pointer" :
                "bg-apex-surface text-apex-muted cursor-not-allowed"
              )}>
              {i < currentStep ? <Check size={16} /> : <Icon size={16} />}
              {step.label}
            </button>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="card">
        {/* Step 0: Organization */}
        {currentStep === 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Organization Details</h2>
            {existingOrg && (
              <div className="p-3 bg-green-500/5 border border-green-500/20 rounded-lg text-sm text-green-400">
                Using existing organization: {existingOrg.name}
              </div>
            )}
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
                <option>1-10</option><option>11-50</option><option>51-200</option><option>200+</option>
              </select>
            </div>
          </div>
        )}

        {/* Step 1: Domain */}
        {currentStep === 1 && (
          <div>
            <h2 className="text-lg font-semibold mb-4">Select Your Domain</h2>
            <div className="grid gap-4">
              {domains.map((domain) => (
                <button key={domain.id} onClick={() => { setSelectedDomain(domain.id); setSelectedTemplate(null); setAgentName(""); }}
                  className={cn("card text-left transition-colors",
                    selectedDomain === domain.id ? "border-apex-indigo bg-apex-indigo/5" : "hover:border-apex-indigo/50")}>
                  <div className="flex items-center gap-4">
                    <span className="text-3xl">{domain.icon}</span>
                    <div>
                      <p className="font-semibold">{domain.name}</p>
                      <p className="text-sm text-apex-muted">{domain.desc}</p>
                    </div>
                    {selectedDomain === domain.id && <Check size={20} className="text-apex-indigo ml-auto" />}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: Template */}
        {currentStep === 2 && (
          <div>
            <h2 className="text-lg font-semibold mb-4">Choose an Agent Template</h2>
            <p className="text-apex-muted text-sm mb-4">
              {filteredTemplates.length} template{filteredTemplates.length !== 1 ? "s" : ""} available for {selectedDomain}
            </p>
            <div className="space-y-3">
              {filteredTemplates.map((tmpl) => (
                <button key={tmpl.id} onClick={() => { setSelectedTemplate(tmpl.id); setAgentName(""); setAgentConfig({}); }}
                  className={cn("card w-full text-left cursor-pointer transition-colors",
                    selectedTemplate === tmpl.id ? "border-apex-indigo bg-apex-indigo/5" : "hover:border-apex-indigo/50")}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold">{tmpl.name}</p>
                      <p className="text-sm text-apex-muted">{tmpl.description}</p>
                      {tmpl.requiredIntegrations.length > 0 && (
                        <p className="text-xs text-apex-muted mt-1">
                          Requires: {tmpl.requiredIntegrations.join(", ")}
                        </p>
                      )}
                    </div>
                    {selectedTemplate === tmpl.id && <Check size={20} className="text-apex-indigo" />}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: Integrations */}
        {currentStep === 3 && (
          <div>
            <h2 className="text-lg font-semibold mb-4">Connect Integrations</h2>
            <p className="text-apex-muted text-sm mb-4">
              {requiredIntegrations.length > 0
                ? `This agent requires: ${requiredIntegrations.join(", ")}. Connect them below.`
                : "Connect the tools your agent needs. You can skip this step."}
            </p>
            <div className="space-y-3">
              {[
                { name: "Gmail", provider: "gmail", icon: "📧", type: "email" },
                { name: "Outlook", provider: "outlook", icon: "📬", type: "email" },
                { name: "HubSpot", provider: "hubspot", icon: "🟠", type: "crm" },
              ].map((item) => {
                const isConnected = connectedIntegrations.has(item.provider);
                const isRequired = requiredIntegrations.includes(item.type);
                const isConnecting = connectingProvider === item.provider;
                return (
                  <div key={item.provider} className={`flex items-center justify-between p-4 bg-apex-surface rounded-lg border ${isRequired ? "border-apex-indigo/30" : "border-apex-border"}`}>
                    <div className="flex items-center gap-3">
                      <span className="text-xl">{item.icon}</span>
                      <div>
                        <span className="font-medium">{item.name}</span>
                        {isRequired && <span className="ml-2 text-xs text-apex-indigo-light">Required</span>}
                      </div>
                    </div>
                    {isConnected ? (
                      <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-500/10 text-green-400">
                        <Check size={14} /> Connected
                      </span>
                    ) : (
                      <button onClick={() => handleConnectIntegration(item.provider)} disabled={isConnecting}
                        className="btn-primary text-sm px-3 py-1.5">
                        {isConnecting ? <Loader2 size={14} className="animate-spin" /> : "Connect"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 4: Configure */}
        {currentStep === 4 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Configure Your Agent</h2>
            <div>
              <label className="block text-sm text-apex-muted mb-1">Agent Name *</label>
              <input type="text" placeholder="My SDR Agent" className="input-field w-full"
                value={agentName} onChange={(e) => setAgentName(e.target.value)} />
            </div>

            {templateConfigSchema.map((field) => (
              <div key={field.key}>
                <label className="block text-sm text-apex-muted mb-1">{field.label}</label>
                {field.type === "select" ? (
                  <select className="input-field w-full" value={agentConfig[field.key] || ""} onChange={(e) => updateConfig(field.key, e.target.value)}>
                    <option value="">Select...</option>
                    {field.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : field.type === "textarea" ? (
                  <textarea className="input-field w-full h-20 resize-none" placeholder={field.placeholder}
                    value={agentConfig[field.key] || ""} onChange={(e) => updateConfig(field.key, e.target.value)} />
                ) : field.type === "number" ? (
                  <input type="number" className="input-field w-full" placeholder={field.placeholder}
                    value={agentConfig[field.key] || ""} onChange={(e) => updateConfig(field.key, e.target.value)} />
                ) : field.type === "tags" ? (
                  <input type="text" className="input-field w-full" placeholder={field.placeholder}
                    value={agentConfig[field.key] || ""} onChange={(e) => updateConfig(field.key, e.target.value)} />
                ) : (
                  <input type="text" className="input-field w-full" placeholder={field.placeholder}
                    value={agentConfig[field.key] || ""} onChange={(e) => updateConfig(field.key, e.target.value)} />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Step 5: Deploy */}
        {currentStep === 5 && (
          <div className="text-center py-8">
            {deployed ? (
              <>
                <Check size={48} className="mx-auto text-green-400 mb-4" />
                <h2 className="text-xl font-semibold mb-2">Agent Deployed!</h2>
                <p className="text-apex-muted">First run triggered. Redirecting to dashboard...</p>
              </>
            ) : (
              <>
                <Rocket size={48} className="mx-auto text-apex-indigo mb-4" />
                <h2 className="text-xl font-semibold mb-2">Ready to Deploy!</h2>
                <div className="text-left max-w-sm mx-auto mb-6 space-y-2">
                  <div className="flex justify-between text-sm"><span className="text-apex-muted">Organization</span><span className="font-medium">{orgName}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-apex-muted">Domain</span><span className="font-medium">{selectedDomain}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-apex-muted">Template</span><span className="font-medium">{selectedTemplateObj?.name}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-apex-muted">Agent Name</span><span className="font-medium">{agentName}</span></div>
                  {Object.entries(agentConfig).filter(([, v]) => v).map(([key, val]) => (
                    <div key={key} className="flex justify-between text-sm">
                      <span className="text-apex-muted capitalize">{key.replace(/([A-Z])/g, " $1")}</span>
                      <span className="font-medium text-right max-w-[200px] truncate">{val}</span>
                    </div>
                  ))}
                  {connectedIntegrations.size > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-apex-muted">Integrations</span>
                      <span className="font-medium">{[...connectedIntegrations].join(", ")}</span>
                    </div>
                  )}
                </div>
                <button onClick={handleDeploy} disabled={deploying}
                  className="btn-primary text-lg px-8 py-3 inline-flex items-center gap-2">
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
          <button onClick={() => setCurrentStep(Math.max(0, currentStep - 1))} className="btn-secondary flex items-center gap-2" disabled={currentStep === 0}>
            <ArrowLeft size={14} /> Previous
          </button>
          {currentStep < 5 && (
            <button onClick={() => setCurrentStep(currentStep + 1)} className="btn-primary" disabled={!canGoNext()}>
              {currentStep === 4 ? "Review & Deploy" : "Next"}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
