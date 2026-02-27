import { Building2, CreditCard, Users, Shield } from "lucide-react";

export default function SettingsPage() {
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
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-apex-muted mb-1">
                Organization Name
              </label>
              <input
                type="text"
                placeholder="Your Company"
                className="input-field w-full max-w-md"
                disabled
              />
            </div>
            <div>
              <label className="block text-sm text-apex-muted mb-1">
                Slug
              </label>
              <input
                type="text"
                placeholder="your-company"
                className="input-field w-full max-w-md"
                disabled
              />
            </div>
          </div>
        </div>

        {/* Billing */}
        <div className="card">
          <div className="flex items-center gap-3 mb-6">
            <CreditCard size={20} className="text-apex-indigo" />
            <h2 className="text-lg font-semibold">Billing</h2>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Trial Plan</p>
              <p className="text-sm text-apex-muted">
                3-day free trial, no credit card required
              </p>
            </div>
            <button className="btn-primary">Upgrade Plan</button>
          </div>
        </div>

        {/* Team */}
        <div className="card">
          <div className="flex items-center gap-3 mb-6">
            <Users size={20} className="text-apex-indigo" />
            <h2 className="text-lg font-semibold">Team Members</h2>
          </div>
          <p className="text-apex-muted text-sm">
            Team management coming in a future update.
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
      </div>
    </div>
  );
}
