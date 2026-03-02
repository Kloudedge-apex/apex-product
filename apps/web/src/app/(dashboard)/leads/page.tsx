"use client";

import { Users } from "lucide-react";

export default function LeadsPage() {
  return (
    <div className="p-6 lg:p-8 max-w-[1400px] mx-auto animate-fade-in">
      <div className="flex items-center gap-2.5 mb-2">
        <Users size={22} className="text-apex-indigo-light" />
        <h1 className="text-2xl font-bold text-white">Leads</h1>
      </div>
      <p className="text-sm text-apex-muted">Lead management coming soon.</p>
    </div>
  );
}
