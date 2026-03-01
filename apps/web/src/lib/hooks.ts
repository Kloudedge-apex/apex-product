"use client";

import useSWR from "swr";
import { api } from "./api";

/** Dashboard data fetched via SWR with auto-refresh */
export function useDashboardData(orgId: string | null) {
  const { data: stats, error: statsError, isLoading: statsLoading } = useSWR(
    orgId ? ["org-stats", orgId] : null,
    () => api.orgs.getStats(orgId!),
    { refreshInterval: 10_000 },
  );

  const { data: agents, error: agentsError, isLoading: agentsLoading } = useSWR(
    orgId ? ["agents", orgId] : null,
    () => api.agents.list(orgId!),
    { refreshInterval: 10_000 },
  );

  const { data: runsData, error: runsError, isLoading: runsLoading, mutate: mutateRuns } = useSWR(
    orgId ? ["runs", orgId] : null,
    () => api.runs.listByOrg(orgId!, 50),
    { refreshInterval: 10_000 },
  );

  const runs = Array.isArray(runsData) ? runsData : (runsData?.runs || []);

  return {
    stats: stats || null,
    agents: Array.isArray(agents) ? agents : [],
    runs,
    runsTotal: runsData?.total || runs.length,
    isLoading: statsLoading || agentsLoading || runsLoading,
    error: statsError || agentsError || runsError,
    mutateRuns,
  };
}

/** Fetch org by clerk user */
export function useOrg(clerkUserId: string | undefined) {
  const { data, error, isLoading } = useSWR(
    clerkUserId ? ["org", clerkUserId] : null,
    () => api.orgs.getByClerkUser(clerkUserId!),
  );

  return {
    org: data || null,
    orgId: data?.id || null,
    error,
    isLoading,
  };
}
