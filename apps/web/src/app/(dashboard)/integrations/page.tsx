import { Zap } from "lucide-react";

const availableIntegrations = [
  { name: "Gmail", provider: "gmail", icon: "📧", category: "Email" },
  { name: "Outlook", provider: "outlook", icon: "📬", category: "Email" },
  { name: "HubSpot", provider: "hubspot", icon: "🟠", category: "CRM" },
  { name: "Salesforce", provider: "salesforce", icon: "☁️", category: "CRM" },
  { name: "LinkedIn", provider: "linkedin", icon: "💼", category: "Social" },
  { name: "Slack", provider: "slack", icon: "💬", category: "Communication" },
  { name: "Typefully", provider: "typefully", icon: "✍️", category: "Social" },
  { name: "Google Analytics", provider: "ga", icon: "📊", category: "Analytics" },
];

export default function IntegrationsPage() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="text-apex-muted mt-1">Connect your tools</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {availableIntegrations.map((integration) => (
          <div key={integration.provider} className="card flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{integration.icon}</span>
              <div>
                <p className="font-medium">{integration.name}</p>
                <p className="text-xs text-apex-muted">{integration.category}</p>
              </div>
            </div>
            <button className="btn-secondary text-sm px-3 py-1.5">
              Connect
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
