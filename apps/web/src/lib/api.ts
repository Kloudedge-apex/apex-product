const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

async function fetchAPI(path: string, options?: RequestInit) {
  const res = await fetch(`${API_URL}/api${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: "API error" }));
    throw new Error(error.message || `API error: ${res.status}`);
  }

  return res.json();
}

// Orgs
export const api = {
  orgs: {
    create: (data: { name: string; slug?: string; clerkUserId: string; email: string; userName?: string }) =>
      fetchAPI("/orgs", { method: "POST", body: JSON.stringify(data) }),
    get: (id: string) => fetchAPI(`/orgs/${id}`),
    getByClerkUser: (clerkId: string) => fetchAPI(`/orgs/by-clerk/${clerkId}`),
    getStats: (orgId: string) => fetchAPI(`/orgs/${orgId}/stats`),
    update: (id: string, data: Record<string, unknown>) =>
      fetchAPI(`/orgs/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  },

  agents: {
    list: (orgId: string) => fetchAPI(`/agents?orgId=${orgId}`),
    get: (id: string) => fetchAPI(`/agents/${id}`),
    analytics: (id: string) => fetchAPI(`/agents/${id}/analytics`),
    create: (data: Record<string, unknown>) =>
      fetchAPI("/agents", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      fetchAPI(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (id: string) => fetchAPI(`/agents/${id}`, { method: "DELETE" }),
    deploy: (id: string) => fetchAPI(`/agents/${id}/deploy`, { method: "POST" }),
    pause: (id: string) => fetchAPI(`/agents/${id}/pause`, { method: "POST" }),
    templates: (domain?: string) => fetchAPI(`/agents/templates${domain ? `?domain=${domain}` : ""}`),
    templateConfigs: (domain?: string) => fetchAPI(`/agents/template-configs${domain ? `?domain=${domain}` : ""}`),
    templateConfig: (slug: string) => fetchAPI(`/agents/template-configs/${slug}`),
    createFromTemplate: (data: { orgId: string; templateSlug: string; name?: string; configOverrides?: Record<string, unknown>; schedule?: string }) =>
      fetchAPI("/agents/from-template", { method: "POST", body: JSON.stringify(data) }),
    getMemories: (id: string) => fetchAPI(`/agents/${id}/memories`),
    setMemory: (id: string, key: string, value: unknown) =>
      fetchAPI(`/agents/${id}/memories`, { method: "POST", body: JSON.stringify({ key, value }) }),
    deleteMemory: (id: string, key: string) =>
      fetchAPI(`/agents/${id}/memories/${encodeURIComponent(key)}`, { method: "DELETE" }),
    clearMemories: (id: string) =>
      fetchAPI(`/agents/${id}/memories`, { method: "DELETE" }),
  },

  runs: {
    listByOrg: (orgId: string, limit?: number, opts?: { offset?: number; status?: string; agentId?: string; from?: string; to?: string; search?: string }) => {
      const params = new URLSearchParams({ orgId });
      if (limit) params.set("limit", String(limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      if (opts?.status) params.set("status", opts.status);
      if (opts?.agentId) params.set("agentId", opts.agentId);
      if (opts?.from) params.set("from", opts.from);
      if (opts?.to) params.set("to", opts.to);
      if (opts?.search) params.set("search", opts.search);
      return fetchAPI(`/runs?${params.toString()}`);
    },
    listByAgent: (agentId: string, limit?: number) => fetchAPI(`/runs/agent/${agentId}${limit ? `&limit=${limit}` : ""}`),
    get: (id: string) => fetchAPI(`/runs/${id}`),
    trigger: (agentId: string, orgId: string) =>
      fetchAPI(`/agents/${agentId}/runs`, { method: "POST", body: JSON.stringify({ orgId }) }),
    cancel: (agentId: string, runId: string) =>
      fetchAPI(`/runtime/cancel/${runId}`, { method: "POST" }),
  },

  integrations: {
    list: (orgId: string) => fetchAPI(`/integrations?orgId=${orgId}`),
    create: (data: { orgId: string; provider: string; credentials: Record<string, unknown> }) =>
      fetchAPI("/integrations", { method: "POST", body: JSON.stringify(data) }),
    delete: (id: string) => fetchAPI(`/integrations/${id}`, { method: "DELETE" }),
    connect: (orgId: string, provider: string) =>
      fetchAPI("/integrations/connect", { method: "POST", body: JSON.stringify({ orgId, provider }) }),
    health: (id: string) => fetchAPI(`/integrations/${id}/health`),
  },

  billing: {
    get: (orgId: string) => fetchAPI(`/billing/${orgId}`),
    subscribe: (orgId: string, planId: string) =>
      fetchAPI("/billing/subscribe", { method: "POST", body: JSON.stringify({ orgId, planId }) }),
    upgrade: (orgId: string, plan: string) =>
      fetchAPI("/billing/upgrade", { method: "POST", body: JSON.stringify({ orgId, plan }) }),
  },

  health: () => fetchAPI("/health"),
};
