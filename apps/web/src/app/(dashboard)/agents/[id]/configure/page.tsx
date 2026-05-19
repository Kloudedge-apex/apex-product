// TODO: Wire to API - currently mock data
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import {
  Bot, Settings, Play, Pause, Trash2, Save, TestTube, Clock, Zap,
  Mail, ChevronDown, ToggleLeft, ToggleRight, Shield, AlertTriangle,
  CheckCircle, XCircle, Pencil, Check, X, Slack, ArrowLeft,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";

/* ---- Mock agent config ---- */
const AGENT = {
  id: "agt_sdr_001",
  name: "Apex SDR Agent",
  domain: "SALES",
  status: "active" as "active" | "paused",
  schedule: "daily",
  nextRun: "2026-03-03 09:00 UTC",
  integrations: {
    gmail:    { connected: true,  email: "kestrel@kloudedge.co", connectedAt: "2026-02-15" },
    outlook:  { connected: false, email: null, connectedAt: null },
    hubspot:  { connected: true,  email: null, connectedAt: "2026-02-20" },
    linkedin: { connected: false, email: null, connectedAt: null },
    slack:    { connected: true,  email: null, connectedAt: "2026-02-18" },
  },
  behavior: {
    tone: 65,
    aggressiveness: 35,
    maxEmailsPerDay: 10,
    followUpCadence: 3,
  },
  approvalMode: "require-approval" as "auto-send" | "require-approval",
};

const SCHEDULES = [
  { value: "hourly", label: "Every Hour" },
  { value: "every4h", label: "Every 4 Hours" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "manual", label: "Manual Only" },
];

const INTEGRATION_META: Record<string, { label: string; icon: typeof Mail; color: string; desc: string }> = {
  gmail:    { label: "Gmail",    icon: Mail,  color: "text-red-400",    desc: "Send and track emails via Gmail" },
  outlook:  { label: "Outlook",  icon: Mail,  color: "text-blue-400",   desc: "Send and track emails via Outlook" },
  hubspot:  { label: "HubSpot",  icon: Zap,   color: "text-orange-400", desc: "Sync contacts and deals" },
  linkedin: { label: "LinkedIn", icon: Zap,   color: "text-sky-400",    desc: "Send connection requests and messages" },
  slack:    { label: "Slack",    icon: Slack,  color: "text-purple-400", desc: "Get notifications and approvals" },
};

const DOMAIN_COLORS: Record<string, string> = {
  SALES: "bg-blue-500/10 text-blue-400 border border-blue-500/20",
  MARKETING: "bg-purple-500/10 text-purple-400 border border-purple-500/20",
  OPS: "bg-orange-500/10 text-orange-400 border border-orange-500/20",
};

export default function AgentConfigurePage() {
  const params = useParams();
  const [agentName, setAgentName] = useState(AGENT.name);
  const [isEditingName, setIsEditingName] = useState(false);
  const [tempName, setTempName] = useState(AGENT.name);
  const [status, setStatus] = useState(AGENT.status);
  const [schedule, setSchedule] = useState(AGENT.schedule);
  const [integrations, setIntegrations] = useState(AGENT.integrations);
  const [tone, setTone] = useState(AGENT.behavior.tone);
  const [aggressiveness, setAggressiveness] = useState(AGENT.behavior.aggressiveness);
  const [maxEmails, setMaxEmails] = useState(AGENT.behavior.maxEmailsPerDay);
  const [followUpDays, setFollowUpDays] = useState(AGENT.behavior.followUpCadence);
  const [approvalMode, setApprovalMode] = useState(AGENT.approvalMode);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const toggleIntegration = (key: string) => {
    setIntegrations((prev) => ({
      ...prev,
      [key]: {
        ...prev[key as keyof typeof prev],
        connected: !prev[key as keyof typeof prev].connected,
        connectedAt: prev[key as keyof typeof prev].connected ? null : new Date().toISOString().split("T")[0],
      },
    }));
  };

  return (
    <div className="p-6 lg:p-8 max-w-[1000px] mx-auto space-y-6 animate-fade-in pb-24">
      {/* Back link */}
      <Link href="/agents" className="btn-ghost inline-flex items-center gap-1.5 -ml-2">
        <ArrowLeft size={14} /> Back to Agents
      </Link>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-apex-indigo/20 flex items-center justify-center">
            <Bot size={20} className="text-apex-indigo-light" />
          </div>
          <div>
            {isEditingName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={tempName}
                  onChange={(e) => setTempName(e.target.value)}
                  className="input-field py-1 px-2 text-lg font-bold"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { setAgentName(tempName); setIsEditingName(false); }
                    if (e.key === "Escape") { setTempName(agentName); setIsEditingName(false); }
                  }}
                />
                <button onClick={() => { setAgentName(tempName); setIsEditingName(false); }} className="text-green-400 hover:text-green-300"><Check size={16} /></button>
                <button onClick={() => { setTempName(agentName); setIsEditingName(false); }} className="text-red-400 hover:text-red-300"><X size={16} /></button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-white">{agentName}</h1>
                <button onClick={() => setIsEditingName(true)} className="text-apex-muted hover:text-white"><Pencil size={13} /></button>
              </div>
            )}
            <div className="flex items-center gap-2 mt-1">
              <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded", DOMAIN_COLORS[AGENT.domain])}>
                {AGENT.domain}
              </span>
              <span className="text-xs text-apex-muted">ID: {AGENT.id}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-secondary flex items-center gap-1.5 text-sm">
            <TestTube size={14} /> Test Run
          </button>
          {/* Status toggle */}
          <button
            onClick={() => setStatus(status === "active" ? "paused" : "active")}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all",
              status === "active"
                ? "bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20"
                : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 hover:bg-yellow-500/20"
            )}
          >
            {status === "active" ? <><ToggleRight size={16} /> Active</> : <><ToggleLeft size={16} /> Paused</>}
          </button>
        </div>
      </div>

      {/* Schedule */}
      <div className="card-glass">
        <h2 className="section-title mb-4 flex items-center gap-2"><Clock size={16} className="text-apex-indigo-light" /> Schedule</h2>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1">
            <label className="text-xs text-apex-muted font-medium mb-1.5 block">Run Frequency</label>
            <select value={schedule} onChange={(e) => setSchedule(e.target.value)} className="input-field w-full py-2.5">
              {SCHEDULES.map((s) => (<option key={s.value} value={s.value}>{s.label}</option>))}
            </select>
          </div>
          <div className="flex-1">
            <label className="text-xs text-apex-muted font-medium mb-1.5 block">Next Scheduled Run</label>
            <div className="input-field w-full py-2.5 flex items-center gap-2 text-sm bg-white/[0.02] cursor-not-allowed">
              <Clock size={14} className="text-apex-indigo-light" />
              <span className="text-white">{AGENT.nextRun}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Integrations */}
      <div className="card-glass">
        <h2 className="section-title mb-4 flex items-center gap-2"><Zap size={16} className="text-apex-indigo-light" /> Integrations</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Object.entries(INTEGRATION_META).map(([key, meta]) => {
            const state = integrations[key as keyof typeof integrations];
            const Icon = meta.icon;
            return (
              <div key={key} className={cn(
                "rounded-lg border p-4 transition-all",
                state.connected
                  ? "border-green-500/20 bg-green-500/[0.03]"
                  : "border-apex-border bg-white/[0.01]"
              )}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon size={16} className={meta.color} />
                    <span className="text-sm font-medium text-white">{meta.label}</span>
                  </div>
                  {state.connected ? (
                    <span className="badge-green text-[10px]"><CheckCircle size={10} /> Connected</span>
                  ) : (
                    <span className="badge-gray text-[10px]"><XCircle size={10} /> Disconnected</span>
                  )}
                </div>
                <p className="text-[11px] text-apex-muted mb-3">{meta.desc}</p>
                {state.connected && state.email && (
                  <p className="text-[10px] text-apex-muted mb-2">{state.email}</p>
                )}
                {state.connected && state.connectedAt && (
                  <p className="text-[10px] text-apex-muted mb-2">Connected {state.connectedAt}</p>
                )}
                <button
                  onClick={() => toggleIntegration(key)}
                  className={cn(
                    "w-full text-xs font-medium py-1.5 rounded-md transition-all",
                    state.connected
                      ? "bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20"
                      : "bg-apex-indigo/10 text-apex-indigo-light hover:bg-apex-indigo/20 border border-apex-indigo/20"
                  )}
                >
                  {state.connected ? "Disconnect" : "Connect"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Behavior */}
      <div className="card-glass">
        <h2 className="section-title mb-4 flex items-center gap-2"><Settings size={16} className="text-apex-indigo-light" /> Behavior</h2>
        <div className="space-y-6">
          {/* Tone slider */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-apex-muted font-medium">Tone</label>
              <span className="text-xs text-white font-medium">{tone < 33 ? "Formal" : tone > 66 ? "Casual" : "Balanced"}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-apex-muted w-12">Formal</span>
              <input type="range" min={0} max={100} value={tone} onChange={(e) => setTone(Number(e.target.value))}
                className="flex-1 h-1.5 rounded-full appearance-none bg-apex-surface [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-apex-indigo-light [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg" />
              <span className="text-[10px] text-apex-muted w-12 text-right">Casual</span>
            </div>
          </div>

          {/* Aggressiveness slider */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-apex-muted font-medium">Aggressiveness</label>
              <span className="text-xs text-white font-medium">{aggressiveness < 33 ? "Conservative" : aggressiveness > 66 ? "Aggressive" : "Moderate"}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-apex-muted w-20">Conservative</span>
              <input type="range" min={0} max={100} value={aggressiveness} onChange={(e) => setAggressiveness(Number(e.target.value))}
                className="flex-1 h-1.5 rounded-full appearance-none bg-apex-surface [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-apex-indigo-light [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg" />
              <span className="text-[10px] text-apex-muted w-20 text-right">Aggressive</span>
            </div>
          </div>

          {/* Max emails */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-apex-muted font-medium mb-1.5 block">Max Emails Per Day</label>
              <input type="number" min={1} max={100} value={maxEmails} onChange={(e) => setMaxEmails(Number(e.target.value))}
                className="input-field w-full py-2.5" />
            </div>
            <div>
              <label className="text-xs text-apex-muted font-medium mb-1.5 block">Follow-up Cadence (days)</label>
              <input type="number" min={1} max={30} value={followUpDays} onChange={(e) => setFollowUpDays(Number(e.target.value))}
                className="input-field w-full py-2.5" />
            </div>
          </div>
        </div>
      </div>

      {/* Approval Mode */}
      <div className="card-glass">
        <h2 className="section-title mb-4 flex items-center gap-2"><Shield size={16} className="text-apex-indigo-light" /> Approval Mode</h2>
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={() => setApprovalMode("auto-send")}
            className={cn(
              "flex-1 rounded-lg border p-4 text-left transition-all",
              approvalMode === "auto-send"
                ? "border-apex-indigo/40 bg-apex-indigo/10"
                : "border-apex-border bg-white/[0.01] hover:bg-white/[0.03]"
            )}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <Zap size={14} className={approvalMode === "auto-send" ? "text-apex-indigo-light" : "text-apex-muted"} />
              <span className={cn("text-sm font-medium", approvalMode === "auto-send" ? "text-white" : "text-apex-muted")}>Auto-Send</span>
            </div>
            <p className="text-[11px] text-apex-muted">Agent sends emails automatically without human review. Faster but less control.</p>
          </button>
          <button
            onClick={() => setApprovalMode("require-approval")}
            className={cn(
              "flex-1 rounded-lg border p-4 text-left transition-all",
              approvalMode === "require-approval"
                ? "border-apex-indigo/40 bg-apex-indigo/10"
                : "border-apex-border bg-white/[0.01] hover:bg-white/[0.03]"
            )}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <Shield size={14} className={approvalMode === "require-approval" ? "text-apex-indigo-light" : "text-apex-muted"} />
              <span className={cn("text-sm font-medium", approvalMode === "require-approval" ? "text-white" : "text-apex-muted")}>Require Approval</span>
            </div>
            <p className="text-[11px] text-apex-muted">All outreach requires your approval before sending. More control, review each message.</p>
          </button>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="card-glass !border-red-500/20">
        <h2 className="section-title mb-4 flex items-center gap-2 text-red-400"><AlertTriangle size={16} /> Danger Zone</h2>
        <div className="flex flex-col sm:flex-row gap-3">
          <button className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-yellow-500/20 bg-yellow-500/[0.05] text-yellow-400 hover:bg-yellow-500/10 text-sm font-medium transition-all">
            <Pause size={14} /> Pause Agent
          </button>
          <button className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-red-500/20 bg-red-500/[0.05] text-red-400 hover:bg-red-500/10 text-sm font-medium transition-all">
            <Trash2 size={14} /> Delete Agent
          </button>
        </div>
      </div>

      {/* Sticky Save Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-30 bg-apex-navy/90 backdrop-blur-lg border-t border-apex-border/60">
        <div className="max-w-[1000px] mx-auto px-6 py-3 flex items-center justify-between">
          <p className="text-xs text-apex-muted">Unsaved changes will be lost</p>
          <button onClick={handleSave} className={cn("btn-primary flex items-center gap-2", saved && "!bg-green-600")}>
            {saved ? <><CheckCircle size={14} /> Saved!</> : <><Save size={14} /> Save Changes</>}
          </button>
        </div>
      </div>
    </div>
  );
}
