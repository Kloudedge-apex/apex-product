"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { Zap, Loader2, CheckCircle, XCircle, AlertCircle, Trash2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";

interface Integration {
  id: string;
  provider: string;
  status: string;
  createdAt: string;
}

interface HealthStatus {
  status: string;
  message: string;
}

const availableIntegrations = [
  { name: "Gmail", provider: "gmail", icon: "📧", category: "Email", description: "Send and read emails via Gmail" },
  { name: "Outlook", provider: "outlook", icon: "📬", category: "Email", description: "Microsoft 365 email integration" },
  { name: "HubSpot", provider: "hubspot", icon: "🟠", category: "CRM", description: "Sync contacts, deals, and companies" },
  { name: "Salesforce", provider: "salesforce", icon: "☁️", category: "CRM", description: "CRM data sync (coming soon)" },
  { name: "LinkedIn", provider: "linkedin", icon: "💼", category: "Social", description: "Social engagement (coming soon)" },
  { name: "Slack", provider: "slack", icon: "💬", category: "Communication", description: "Team notifications (coming soon)" },
];

const connectableProviders = new Set(["gmail", "outlook", "hubspot"]);

export default function IntegrationsPage() {
  const { user } = useUser();
  const searchParams = useSearchParams();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [connected, setConnected] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [healthStatuses, setHealthStatuses] = useState<Record<string, HealthStatus>>({});
  const [notification, setNotification] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Check for OAuth callback params
  useEffect(() => {
    const connectedProvider = searchParams.get("connected");
    const errorProvider = searchParams.get("error");
    if (connectedProvider) {
      setNotification({ type: "success", message: `${connectedProvider} connected successfully!` });
    }
    if (errorProvider) {
      setNotification({ type: "error", message: `Failed to connect ${errorProvider}. Please try again.` });
    }
  }, [searchParams]);

  useEffect(() => {
    async function load() {
      if (!user?.id) return;
      try {
        const org = await api.orgs.getByClerkUser(user.id).catch(() => null);
        if (org?.id) {
          setOrgId(org.id);
          const integrations = await api.integrations.list(org.id).catch(() => []);
          setConnected(Array.isArray(integrations) ? integrations : []);
        }
      } catch {
        // silently handle
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [user?.id]);

  // Clear notification after 5s
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  async function handleConnect(provider: string) {
    if (!orgId) return;
    setConnecting(provider);
    try {
      const result = await api.integrations.connect(orgId, provider);
      setConnected((prev) => {
        const filtered = prev.filter((i) => i.provider !== provider);
        return [...filtered, result];
      });
      setNotification({ type: "success", message: `${provider} connected successfully!` });
    } catch {
      setNotification({ type: "error", message: `Failed to connect ${provider}` });
    } finally {
      setConnecting(null);
    }
  }

  async function handleDisconnect(integration: Integration) {
    try {
      await api.integrations.delete(integration.id);
      setConnected((prev) => prev.filter((i) => i.id !== integration.id));
      setHealthStatuses((prev) => {
        const copy = { ...prev };
        delete copy[integration.id];
        return copy;
      });
      setNotification({ type: "success", message: `${integration.provider} disconnected.` });
    } catch {
      setNotification({ type: "error", message: "Failed to disconnect integration" });
    }
  }

  async function handleHealthCheck(integration: Integration) {
    try {
      const health = await api.integrations.health(integration.id);
      setHealthStatuses((prev) => ({ ...prev, [integration.id]: health }));
    } catch {
      setHealthStatuses((prev) => ({ ...prev, [integration.id]: { status: "error", message: "Health check failed" } }));
    }
  }

  function getIntegrationForProvider(provider: string): Integration | undefined {
    return connected.find((i) => i.provider === provider);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-apex-indigo" size={32} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="text-apex-muted mt-1">Connect your tools to power your AI agents</p>
      </div>

      {/* Notification */}
      {notification && (
        <div className={`mb-6 p-4 rounded-lg flex items-center gap-3 ${
          notification.type === "success"
            ? "bg-green-500/10 border border-green-500/30 text-green-400"
            : "bg-red-500/10 border border-red-500/30 text-red-400"
        }`}>
          {notification.type === "success" ? <CheckCircle size={18} /> : <XCircle size={18} />}
          <p className="text-sm">{notification.message}</p>
          <button onClick={() => setNotification(null)} className="ml-auto text-xs opacity-60 hover:opacity-100">
            Dismiss
          </button>
        </div>
      )}

      {/* No org state */}
      {!orgId && (
        <div className="card text-center py-12">
          <Zap size={48} className="mx-auto text-apex-border mb-4" />
          <p className="text-apex-muted">Complete onboarding first to connect integrations.</p>
        </div>
      )}

      {orgId && (
        <>
          {/* Connected integrations summary */}
          {connected.length > 0 && (
            <div className="mb-6">
              <h2 className="text-sm font-medium text-apex-muted mb-3">Connected ({connected.length})</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {connected.map((integration) => {
                  const info = availableIntegrations.find((a) => a.provider === integration.provider);
                  const health = healthStatuses[integration.id];
                  return (
                    <div key={integration.id} className="card border-green-500/20">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <span className="text-2xl">{info?.icon || "🔗"}</span>
                          <div>
                            <p className="font-medium">{info?.name || integration.provider}</p>
                            <p className="text-xs text-apex-muted">{info?.category || "Integration"}</p>
                          </div>
                        </div>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                          Connected
                        </span>
                      </div>

                      {/* Health status */}
                      {health && (
                        <div className={`text-xs p-2 rounded mb-3 ${
                          health.status === "healthy" ? "bg-green-500/5 text-green-400" :
                          health.status === "expired" ? "bg-yellow-500/5 text-yellow-400" :
                          "bg-red-500/5 text-red-400"
                        }`}>
                          {health.message}
                        </div>
                      )}

                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-apex-muted">
                          Connected {new Date(integration.createdAt).toLocaleDateString()}
                        </span>
                        <div className="ml-auto flex items-center gap-1">
                          <button
                            onClick={() => handleHealthCheck(integration)}
                            className="p-1.5 hover:bg-apex-surface rounded text-apex-muted hover:text-white transition-colors"
                            title="Check health"
                          >
                            <RefreshCw size={14} />
                          </button>
                          <button
                            onClick={() => handleDisconnect(integration)}
                            className="p-1.5 hover:bg-red-500/10 rounded text-apex-muted hover:text-red-400 transition-colors"
                            title="Disconnect"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Available integrations */}
          <h2 className="text-sm font-medium text-apex-muted mb-3">
            {connected.length > 0 ? "Available Integrations" : "Connect Your Tools"}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {availableIntegrations.map((integration) => {
              const existingConnection = getIntegrationForProvider(integration.provider);
              const isConnectable = connectableProviders.has(integration.provider);
              const isConnecting = connecting === integration.provider;

              return (
                <div key={integration.provider} className="card flex flex-col">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-2xl">{integration.icon}</span>
                    <div className="flex-1">
                      <p className="font-medium">{integration.name}</p>
                      <p className="text-xs text-apex-muted">{integration.category}</p>
                    </div>
                    {existingConnection && (
                      <CheckCircle size={18} className="text-green-400" />
                    )}
                  </div>
                  <p className="text-xs text-apex-muted mb-4 flex-1">{integration.description}</p>
                  {existingConnection ? (
                    <button
                      onClick={() => handleDisconnect(existingConnection)}
                      className="btn-secondary text-sm py-1.5 w-full flex items-center justify-center gap-2 text-red-400 hover:text-red-300"
                    >
                      <Trash2 size={14} />
                      Disconnect
                    </button>
                  ) : isConnectable ? (
                    <button
                      onClick={() => handleConnect(integration.provider)}
                      disabled={isConnecting}
                      className="btn-primary text-sm py-1.5 w-full flex items-center justify-center gap-2"
                    >
                      {isConnecting ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Zap size={14} />
                      )}
                      {isConnecting ? "Connecting..." : "Connect"}
                    </button>
                  ) : (
                    <button disabled className="btn-secondary text-sm py-1.5 w-full opacity-50 cursor-not-allowed flex items-center justify-center gap-2">
                      <AlertCircle size={14} />
                      Coming Soon
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
