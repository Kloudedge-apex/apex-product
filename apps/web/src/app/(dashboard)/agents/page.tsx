import Link from "next/link";
import { Bot, Plus } from "lucide-react";

export default function AgentsPage() {
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

      {/* Empty State */}
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
    </div>
  );
}
