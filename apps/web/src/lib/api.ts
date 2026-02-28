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
    create: (data: Record<string, unknown>) =>
      fetchAPI("/agents", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      fetchAPI(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (id: string) => fetchAPI(`/agents/${id}`, { method: "DELETE" }),
    deploy: (id: string) => fetchAPI(`/agents/${id}/deploy`, { method: "POST" }),
    pause: (id: string) => fetchAPI(`/agents/${id}/pause`, { method: "POST" }),
    templates: (domain?: string) => fetchAPI(`/agents/templates${domain ? `?domain=${domain}` : ""}`),
  },

  runs: {
    listByOrg: (orgId: string, limit?: number) => fetchAPI(`/runs?orgId=${orgId}${limit ? `&limit=${limit}` : ""}`),
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
