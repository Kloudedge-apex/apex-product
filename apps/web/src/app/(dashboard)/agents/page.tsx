"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { Bot, Plus, Loader2, Target, Megaphone, Cog } from "lucide-react";
import { api } from "@/lib/api";

interface Template {
  slug: string;
  name: string;
  description: string;
  domain: string;
  defaultConfig: Record<string, unknown>;
  requiredIntegrations: string[];
  availableTools: { name: string; description: string }[];
  exampleTasks: string[];
  defaultSchedule: string;
}

interface Agent {
  id: string;
  name: string;
  domain: string;
  status: string;
  templateId: string;
  lastRunAt: string | null;
  createdAt: string;
}

const domainIcons: Record<string, typeof Bot> = {
  SALES: Target,
  MARKETING: Megaphone,
  OPS: Cog,
};

const domainColors: Record<string, string> = {
  SALES: "bg-green-500/10 text-green-400",
  MARKETING: "bg-indigo-500/10 text-indigo-400",
  OPS: "bg-orange-500/10 text-orange-400",
};

export default function AgentsPage() {
  const { user } = useUser();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"my-agents" | "templates">("my-agents");

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [tmpl, org] = await Promise.all([
          api.agents.templateConfigs(),
          user?.id ? api.orgs.getByClerkUser(user.id).catch(() => null) : null,
        ]);
        setTemplates(Array.isArray(tmpl) ? tmpl : []);
        if (org?.id) {
          const agentList = await api.agents.list(org.id).catch(() => []);
          setAgents(Array.isArray(agentList) ? agentList : []);
        }
      } catch {
        // silently handle
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [user?.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-apex-indigo" size={32} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-apex-muted mt-1">Manage your AI workforce</p>
        </div>
        <Link href="/onboarding" className="btn-primary flex items-center gap-2">
          <Plus size={16} />
          New Agent
        </Link>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-apex-surface rounded-lg mb-8 w-fit">
        <button
          onClick={() => setTab("my-agents")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            tab === "my-agents" ? "bg-apex-indigo text-white" : "text-apex-muted hover:text-white"
          }`}
        >
          My Agents ({agents.length})
        </button>
        <button
          onClick={() => setTab("templates")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            tab === "templates" ? "bg-apex-indigo text-white" : "text-apex-muted hover:text-white"
          }`}
        >
          Templates ({templates.length})
        </button>
      </div>

      {tab === "my-agents" && (
        <>
          {agents.length === 0 ? (
            <div className="card text-center py-16">
              <Bot size={64} className="mx-auto text-apex-border mb-6" />
              <h2 className="text-xl font-semibold mb-2">No agents yet</h2>
              <p className="text-apex-muted mb-6 max-w-md mx-auto">
                Create your first AI agent to start automating your Sales,
                Marketing, or Operations workflows.
              </p>
              <Link href="/onboarding" className="btn-primary inline-flex items-center gap-2">
                <Plus size={16} />
                Create Your First Agent
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {agents.map((agent) => {
                const Icon = domainIcons[agent.domain] || Bot;
                return (
                  <Link key={agent.id} href={`/agents/${agent.id}`} className="card hover:border-apex-indigo/50 transition-colors">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-10 h-10 bg-apex-indigo/10 rounded-xl flex items-center justify-center">
                        <Icon size={20} className="text-apex-indigo" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate">{agent.name}</p>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${domainColors[agent.domain] || "bg-gray-500/10 text-gray-400"}`}>
                          {agent.domain}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs text-apex-muted">
                      <span className={`inline-flex items-center gap-1 ${
                        agent.status === "ACTIVE" ? "text-green-400" : "text-yellow-400"
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          agent.status === "ACTIVE" ? "bg-green-400" : "bg-yellow-400"
                        }`} />
                        {agent.status}
                      </span>
                      <span>
                        {agent.lastRunAt ? `Last run: ${new Date(agent.lastRunAt).toLocaleDateString()}` : "Never run"}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "templates" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((tmpl) => {
            const Icon = domainIcons[tmpl.domain] || Bot;
            return (
              <div key={tmpl.slug} className="card">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 bg-apex-indigo/10 rounded-xl flex items-center justify-center">
                    <Icon size={20} className="text-apex-indigo" />
                  </div>
                  <div>
                    <p className="font-semibold">{tmpl.name}</p>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${domainColors[tmpl.domain] || "bg-gray-500/10 text-gray-400"}`}>
                      {tmpl.domain}
                    </span>
                  </div>
                </div>
                <p className="text-sm text-apex-muted mb-4">{tmpl.description}</p>
                <Link
                  href="/onboarding"
                  className="btn-primary w-full text-center text-sm py-2 block"
                >
                  Use Template
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
