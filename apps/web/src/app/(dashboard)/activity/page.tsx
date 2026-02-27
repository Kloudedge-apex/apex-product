import { Activity } from "lucide-react";

export default function ActivityPage() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Activity</h1>
        <p className="text-apex-muted mt-1">Agent run history and logs</p>
      </div>

      <div className="card text-center py-16">
        <Activity size={64} className="mx-auto text-apex-border mb-6" />
        <h2 className="text-xl font-semibold mb-2">No activity yet</h2>
        <p className="text-apex-muted max-w-md mx-auto">
          Once your agents start running, you will see their activity,
          logs, and results here.
        </p>
      </div>
    </div>
  );
}
