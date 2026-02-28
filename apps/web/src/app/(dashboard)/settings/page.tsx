"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { Building2, CreditCard, Users, Shield, Key, Loader2, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";

interface Org {
  id: string;
  name: string;
  slug: string;
  plan: string;
  trialEndsAt: string | null;
  createdAt: string;
  users: Array<{ id: string; email: string; name: string | null; role: string }>;
  agents: Array<{ id: string }>;
  integrations: Array<{ id: string }>;
}

const plans = [
  { id: "STARTER", name: "Starter", price: "$49/mo", agents: "1-2 agents" },
  { id: "GROWTH", name: "Growth", price: "$149/mo", agents: "5-8 agents" },
  { id: "ENTERPRISE", name: "Enterprise", price: "Custom", agents: "Unlimited" },
];

export default function SettingsPage() {
  const { user } = useUser();
  const [org, setOrg] = useState<Org | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  useEffect(() => {
    async function load() {
      if (!user?.id) return;
      try {
        const orgData = await api.orgs.getByClerkUser(user.id).catch(() => null);
        if (orgData) setOrg(orgData);
      } catch { /* */ }
      setLoading(false);
    }
    load();
  }, [user?.id]);

  async function handleUpgrade(plan: string) {
    if (!org) return;
    setUpgrading(true);
    try {
      await api.billing.upgrade(org.id, plan);
      setOrg({ ...org, plan });
    } catch { /* */ }
    setUpgrading(false);
  }

  if (loading) {
    return (<div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="animate-spin text-apex-indigo" size={32} /></div>);
  }

  const trialDaysLeft = org?.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(org.trialEndsAt).getTime() - Date.now()) / 86400000))
    : null;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-apex-muted mt-1">Manage your organization</p>
      </div>

      <div className="space-y-6">
        {/* Organization */}
        <div className="card">
          <div className="flex items-center gap-3 mb-6">
            <Building2 size={20} className="text-apex-indigo" />
            <h2 className="text-lg font-semibold">Organization</h2>
          </div>
          {org ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-apex-muted mb-1">Organization Name</label>
                <input type="text" value={org.name} className="input-field w-full max-w-md" readOnly />
              </div>
              <div>
                <label className="block text-sm text-apex-muted mb-1">Slug</label>
                <input type="text" value={org.slug} className="input-field w-full max-w-md" readOnly />
              </div>
              <div className="flex items-center gap-4 text-sm text-apex-muted">
                <span>Created {new Date(org.createdAt).toLocaleDateString()}</span>
                <span>{org.agents.length} agents</span>
                <span>{org.integrations.length} integrations</span>
              </div>
            </div>
          ) : (
            <p className="text-apex-muted text-sm">No organization found. Complete onboarding first.</p>
          )}
        </div>

        {/* Billing */}
        <div className="card">
          <div className="flex items-center gap-3 mb-6">
            <CreditCard size={20} className="text-apex-indigo" />
            <h2 className="text-lg font-semibold">Billing & Plan</h2>
          </div>

          <div className="mb-6">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-lg font-semibold">{org?.plan || "TRIAL"} Plan</span>
              {org?.plan === "TRIAL" && trialDaysLeft !== null && (
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${trialDaysLeft > 0 ? "bg-yellow-500/10 text-yellow-400" : "bg-red-500/10 text-red-400"}`}>
                  {trialDaysLeft > 0 ? `${trialDaysLeft} days left` : "Trial expired"}
                </span>
              )}
            </div>
            <p className="text-sm text-apex-muted">
              {org?.plan === "TRIAL" ? "Free trial with limited features" :
               org?.plan === "STARTER" ? "For small teams getting started" :
               org?.plan === "GROWTH" ? "For growing teams with multi-domain access" :
               "Full enterprise features with unlimited agents"}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {plans.map((plan) => {
              const isCurrent = org?.plan === plan.id;
              return (
                <div key={plan.id} className={`p-4 rounded-lg border ${isCurrent ? "border-apex-indigo bg-apex-indigo/5" : "border-apex-border"}`}>
                  <p className="font-semibold">{plan.name}</p>
                  <p className="text-xl font-bold mt-1">{plan.price}</p>
                  <p className="text-xs text-apex-muted mt-1">{plan.agents}</p>
                  {isCurrent ? (
                    <span className="inline-block mt-3 text-xs text-apex-indigo-light font-medium">Current Plan</span>
                  ) : (
                    <button
                      onClick={() => handleUpgrade(plan.id)}
                      disabled={upgrading}
                      className="btn-primary text-xs mt-3 w-full py-1.5"
                    >
                      {upgrading ? "Upgrading..." : "Upgrade"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Team */}
        <div className="card">
          <div className="flex items-center gap-3 mb-6">
            <Users size={20} className="text-apex-indigo" />
            <h2 className="text-lg font-semibold">Team Members</h2>
          </div>
          {org?.users && org.users.length > 0 ? (
            <div className="space-y-2">
              {org.users.map((member) => (
                <div key={member.id} className="flex items-center justify-between py-3 border-b border-apex-border last:border-0">
                  <div>
                    <p className="text-sm font-medium">{member.name || member.email}</p>
                    <p className="text-xs text-apex-muted">{member.email}</p>
                  </div>
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-apex-indigo/10 text-apex-indigo-light">
                    {member.role}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-apex-muted text-sm">No team members found.</p>
          )}
        </div>

        {/* API Keys placeholder */}
        <div className="card">
          <div className="flex items-center gap-3 mb-6">
            <Key size={20} className="text-apex-indigo" />
            <h2 className="text-lg font-semibold">API Keys</h2>
          </div>
          <p className="text-apex-muted text-sm">
            API key management is available on the Enterprise plan. Contact sales to learn more.
          </p>
        </div>

        {/* Security */}
        <div className="card">
          <div className="flex items-center gap-3 mb-6">
            <Shield size={20} className="text-apex-indigo" />
            <h2 className="text-lg font-semibold">Security</h2>
          </div>
          <p className="text-apex-muted text-sm">
            SSO and advanced security options available on Enterprise plan.
          </p>
        </div>

        {/* Danger Zone */}
        <div className="card border-red-500/20">
          <div className="flex items-center gap-3 mb-4">
            <AlertTriangle size={20} className="text-red-400" />
            <h2 className="text-lg font-semibold text-red-400">Danger Zone</h2>
          </div>
          {!showDeleteConfirm ? (
            <button onClick={() => setShowDeleteConfirm(true)} className="text-sm text-red-400 hover:text-red-300 transition-colors">
              Delete this organization
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <p className="text-sm text-apex-muted">This will permanently delete your org, all agents, and data.</p>
              <button className="bg-red-500/20 text-red-400 hover:bg-red-500/30 px-4 py-2 rounded-lg text-sm font-medium">
                Confirm Delete
              </button>
              <button onClick={() => setShowDeleteConfirm(false)} className="text-sm text-apex-muted hover:text-white">
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
