"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { Activity, Loader2, CheckCircle, XCircle, Clock } from "lucide-react";
import { api } from "@/lib/api";

interface Run {
  id: string;
  agentId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  tokensUsed: number;
  error: string | null;
}

export default function ActivityPage() {
  const { user } = useUser();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      if (!user?.id) return;
      try {
        const org = await api.orgs.getByClerkUser(user.id).catch(() => null);
        if (org?.id) {
          const data = await api.runs.listByOrg(org.id, 50).catch(() => []);
          setRuns(Array.isArray(data) ? data : []);
        }
      } catch { /* */ }
      setLoading(false);
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
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Activity</h1>
        <p className="text-apex-muted mt-1">Agent run history and logs</p>
      </div>

      {runs.length === 0 ? (
        <div className="card text-center py-16">
          <Activity size={64} className="mx-auto text-apex-border mb-6" />
          <h2 className="text-xl font-semibold mb-2">No activity yet</h2>
          <p className="text-apex-muted max-w-md mx-auto">
            Once your agents start running, you&apos;ll see their activity, logs, and results here.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="space-y-2">
            {runs.map((run) => (
              <div key={run.id} className="flex items-center justify-between p-4 rounded-lg bg-apex-surface">
                <div className="flex items-center gap-3">
                  {run.status === "COMPLETED" ? (
                    <CheckCircle size={18} className="text-green-400" />
                  ) : run.status === "FAILED" ? (
                    <XCircle size={18} className="text-red-400" />
                  ) : (
                    <Clock size={18} className="text-yellow-400" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Agent {run.agentId.slice(0, 8)}...</p>
                    <p className="text-xs text-apex-muted">{new Date(run.startedAt).toLocaleString()}</p>
                  </div>
                </div>
                <div className="text-right">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    run.status === "COMPLETED" ? "bg-green-500/10 text-green-400" :
                    run.status === "FAILED" ? "bg-red-500/10 text-red-400" :
                    "bg-yellow-500/10 text-yellow-400"
                  }`}>
                    {run.status}
                  </span>
                  <p className="text-xs text-apex-muted mt-1">{run.tokensUsed?.toLocaleString() || 0} tokens</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
