import { Bot, Play, Pause, Settings, Clock, Activity } from "lucide-react";

export default function AgentDetailPage({
  params,
}: {
  params: { id: string };
}) {
  return (
    <div>
      {/* Agent Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-apex-indigo/10 rounded-xl flex items-center justify-center">
            <Bot size={24} className="text-apex-indigo" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Agent {params.id}</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 text-xs font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
                Paused
              </span>
              <span className="text-apex-muted text-sm">Sales Domain</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary flex items-center gap-2">
            <Play size={14} />
            Deploy
          </button>
          <button className="btn-secondary flex items-center gap-2">
            <Settings size={14} />
            Configure
          </button>
        </div>
      </div>

      {/* Agent Info Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="card">
          <div className="flex items-center gap-2 text-apex-muted text-sm mb-2">
            <Clock size={14} />
            Schedule
          </div>
          <p className="font-medium">Not configured</p>
        </div>
        <div className="card">
          <div className="flex items-center gap-2 text-apex-muted text-sm mb-2">
            <Activity size={14} />
            Total Runs
          </div>
          <p className="font-medium">0</p>
        </div>
        <div className="card">
          <div className="flex items-center gap-2 text-apex-muted text-sm mb-2">
            <Pause size={14} />
            Status
          </div>
          <p className="font-medium">Paused</p>
        </div>
      </div>

      {/* Run History */}
      <div className="card">
        <h2 className="text-lg font-semibold mb-4">Run History</h2>
        <div className="text-center py-12">
          <Activity size={48} className="mx-auto text-apex-border mb-4" />
          <p className="text-apex-muted">No runs yet</p>
          <p className="text-sm text-apex-muted mt-1">
            Deploy this agent to start seeing run history
          </p>
        </div>
      </div>
    </div>
  );
}
