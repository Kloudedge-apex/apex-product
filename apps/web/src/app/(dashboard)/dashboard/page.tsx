import { Bot, Activity, Zap, TrendingUp } from "lucide-react";

const stats = [
  { label: "Active Agents", value: "0", icon: Bot, change: null },
  { label: "Total Runs", value: "0", icon: Activity, change: null },
  { label: "Integrations", value: "0", icon: Zap, change: null },
  { label: "Tokens Used", value: "0", icon: TrendingUp, change: null },
];

export default function DashboardPage() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-apex-muted mt-1">Overview of your AI workforce</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="card">
              <div className="flex items-center justify-between mb-4">
                <span className="text-apex-muted text-sm">{stat.label}</span>
                <Icon size={18} className="text-apex-indigo" />
              </div>
              <p className="text-3xl font-bold">{stat.value}</p>
            </div>
          );
        })}
      </div>

      {/* Recent Activity */}
      <div className="card">
        <h2 className="text-lg font-semibold mb-4">Recent Activity</h2>
        <div className="text-center py-12">
          <Activity size={48} className="mx-auto text-apex-border mb-4" />
          <p className="text-apex-muted">No activity yet</p>
          <p className="text-sm text-apex-muted mt-1">
            Deploy your first agent to see activity here
          </p>
        </div>
      </div>
    </div>
  );
}
