"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { UserButton } from "@clerk/nextjs";
import {
  LayoutDashboard, Bot, Settings, Zap, Activity, Send,
  Menu, X, ChevronRight, Sparkles, TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useOrg, useDashboardData } from "@/lib/hooks";

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Agents", href: "/agents", icon: Bot },
  { label: "Outreach", href: "/outreach", icon: Send },
  { label: "Integrations", href: "/integrations", icon: Zap },
  { label: "Activity", href: "/activity", icon: Activity },
  { label: "Settings", href: "/settings", icon: Settings },
];

const PLAN_COLORS: Record<string, string> = {
  TRIAL: "bg-gray-500/10 text-gray-400 border border-gray-500/20",
  STARTER: "bg-blue-500/10 text-blue-400 border border-blue-500/20",
  GROWTH: "bg-purple-500/10 text-purple-400 border border-purple-500/20",
  ENTERPRISE: "bg-amber-500/10 text-amber-400 border border-amber-500/20",
};

export function Sidebar() {
  const pathname = usePathname();
  const { user } = useUser();
  const { org, orgId } = useOrg(user?.id);
  const dashData = useDashboardData(orgId);
  const stats = dashData.stats as { activeAgents?: number; runsToday?: number } | null;

  const [mobileOpen, setMobileOpen] = useState(false);

  const plan = (org as { plan?: string } | null)?.plan ?? "TRIAL";
  const activeAgents = stats?.activeAgents ?? 0;
  const runsToday = stats?.runsToday ?? 0;

  const sidebarContent = (
    <div className="flex flex-col h-full">

      {/* ── Logo ───────────────────────────────── */}
      <div className="p-5 border-b border-apex-border/60">
        <Link href="/dashboard" className="flex items-center gap-2.5" onClick={() => setMobileOpen(false)}>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center relative overflow-hidden"
            style={{ background: "linear-gradient(135deg, #6366f1, #818cf8)" }}>
            <Sparkles size={14} className="text-white" />
            <div className="absolute inset-0 bg-white/10 rounded-lg" />
          </div>
          <div>
            <span className="text-base font-bold text-white leading-none block">Apex</span>
            <span className="text-[10px] text-apex-muted leading-none">AI Workforce</span>
          </div>
        </Link>
      </div>

      {/* ── Org card ────────────────────────────── */}
      {org && (
        <div className="mx-3 mt-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate">{(org as { name?: string }).name ?? "My Org"}</p>
              <p className="text-[10px] text-apex-muted mt-0.5">Organization</p>
            </div>
            <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded", PLAN_COLORS[plan])}>
              {plan}
            </span>
          </div>

          {/* Live stats */}
          <div className="flex items-center gap-3 mt-2.5 pt-2.5 border-t border-white/[0.05]">
            <div className="flex items-center gap-1.5">
              <span className="live-dot" />
              <span className="text-[10px] text-apex-muted"><span className="text-green-400 font-medium">{activeAgents}</span> active</span>
            </div>
            <div className="flex items-center gap-1.5">
              <TrendingUp size={10} className="text-apex-indigo-light" />
              <span className="text-[10px] text-apex-muted"><span className="text-white font-medium">{runsToday}</span> runs today</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Navigation ──────────────────────────── */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        <p className="text-[10px] font-semibold text-apex-muted uppercase tracking-wider px-3 pb-2">Navigation</p>
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                isActive ? "nav-item-active" : "nav-item"
              )}
            >
              <Icon size={17} className={isActive ? "text-apex-indigo-light" : ""} />
              {item.label}
              {isActive && <ChevronRight size={12} className="ml-auto text-apex-indigo-light/60" />}
            </Link>
          );
        })}
      </nav>

      {/* ── User ────────────────────────────────── */}
      <div className="p-3 border-t border-apex-border/60">
        <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-white/[0.03] transition-colors cursor-pointer">
          <UserButton
            afterSignOutUrl="/"
            appearance={{ elements: { avatarBox: "w-7 h-7" } }}
          />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-white truncate">
              {user?.firstName ? `${user.firstName} ${user.lastName ?? ""}`.trim() : "My Account"}
            </p>
            <p className="text-[10px] text-apex-muted truncate">{user?.primaryEmailAddress?.emailAddress}</p>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 bg-apex-surface border border-apex-border rounded-lg"
        aria-label="Toggle menu"
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 bg-black/60 z-40 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
      )}

      {/* Mobile sidebar */}
      <aside className={cn(
        "lg:hidden fixed inset-y-0 left-0 z-40 w-64 bg-[#020e1f] border-r border-apex-border/60 flex flex-col h-screen transition-transform duration-300",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {sidebarContent}
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-60 bg-[#020e1f] border-r border-apex-border/60 flex-col h-screen sticky top-0">
        {sidebarContent}
      </aside>
    </>
  );
}
