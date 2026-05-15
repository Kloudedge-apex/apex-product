// TODO: Wire to API - currently mock data
"use client";

import { useState, useMemo } from "react";
import {
  Send, ChevronDown, ChevronRight, Filter, Search, Mail,
  Calendar, Clock, ArrowRight, Eye, Reply, MessageSquare, UserCheck,
  Phone, BarChart3, Target, TrendingUp, Users, X,
} from "lucide-react";
import { cn } from "@/lib/cn";

type Channel = "email" | "linkedin";
type OutreachStatus = "researched" | "qualified" | "contacted" | "opened" | "replied" | "meeting" | "not_interested" | "bounced";

interface Touchpoint { type: string; date: string; detail: string }
interface Prospect {
  id: number; name: string; title: string; company: string; channel: Channel;
  status: OutreachStatus; lastAction: string; lastActionDate: string;
  nextActionDue: string | null; daysInStage: number; timeline: Touchpoint[];
}

const P: Prospect[] = [
  {id:1,name:"Sarah Chen",title:"VP Engineering",company:"Stripe",channel:"email",status:"meeting",lastAction:"Meeting confirmed",lastActionDate:"2026-03-02",nextActionDue:"2026-03-04",daysInStage:1,timeline:[
    {type:"email_sent",date:"2026-02-18 09:15",detail:"Initial outreach: AI-powered dev workflow"},
    {type:"email_opened",date:"2026-02-18 11:42",detail:"Opened 3 times"},
    {type:"follow_up",date:"2026-02-21 09:00",detail:"Follow-up with case study"},
    {type:"email_opened",date:"2026-02-21 10:15",detail:"Opened 2 times, clicked link"},
    {type:"reply_received",date:"2026-02-23 14:30",detail:"Interested, asked for demo"},
    {type:"meeting_booked",date:"2026-03-02 16:00",detail:"Demo call Mar 4 at 2pm EST"},
  ]},
  {id:2,name:"Marcus Johnson",title:"CTO",company:"Notion",channel:"linkedin",status:"replied",lastAction:"Replied on LinkedIn",lastActionDate:"2026-03-01",nextActionDue:"2026-03-03",daysInStage:2,timeline:[
    {type:"linkedin_connect",date:"2026-02-20 10:00",detail:"Connection request sent"},
    {type:"linkedin_message",date:"2026-02-22 09:30",detail:"Intro message about AI ops"},
    {type:"linkedin_reply",date:"2026-03-01 11:15",detail:"Asked for more details on pricing"},
  ]},
  {id:3,name:"Emily Rodriguez",title:"Head of Sales",company:"HubSpot",channel:"email",status:"contacted",lastAction:"Follow-up sent",lastActionDate:"2026-02-28",nextActionDue:"2026-03-03",daysInStage:4,timeline:[
    {type:"email_sent",date:"2026-02-24 08:45",detail:"Cold outreach: SDR automation"},
    {type:"email_opened",date:"2026-02-24 12:00",detail:"Opened 1 time"},
    {type:"follow_up",date:"2026-02-28 09:00",detail:"Follow-up with ROI calculator"},
  ]},
  {id:4,name:"David Kim",title:"VP Revenue",company:"Datadog",channel:"email",status:"opened",lastAction:"Email opened",lastActionDate:"2026-03-01",nextActionDue:"2026-03-03",daysInStage:3,timeline:[
    {type:"email_sent",date:"2026-02-26 10:30",detail:"Intro: AI sales agents for DevTools"},
    {type:"email_opened",date:"2026-03-01 08:20",detail:"Opened 4 times, clicked case study link"},
  ]},
  {id:5,name:"Lisa Wang",title:"Director of Growth",company:"Figma",channel:"linkedin",status:"contacted",lastAction:"LinkedIn message sent",lastActionDate:"2026-02-27",nextActionDue:"2026-03-02",daysInStage:5,timeline:[
    {type:"linkedin_connect",date:"2026-02-22 11:00",detail:"Connection accepted"},
    {type:"linkedin_message",date:"2026-02-27 14:00",detail:"Personalized pitch about PLG automation"},
  ]},
  {id:6,name:"James O’Brien",title:"CRO",company:"Twilio",channel:"email",status:"meeting",lastAction:"Meeting confirmed",lastActionDate:"2026-02-28",nextActionDue:"2026-03-05",daysInStage:2,timeline:[
    {type:"email_sent",date:"2026-02-15 09:00",detail:"Cold outreach: AI-driven pipeline"},
    {type:"email_opened",date:"2026-02-15 14:30",detail:"Opened 2 times"},
    {type:"follow_up",date:"2026-02-18 09:00",detail:"Follow-up with competitor comparison"},
    {type:"reply_received",date:"2026-02-20 10:45",detail:"Forwarded to team, interested"},
    {type:"call",date:"2026-02-25 15:00",detail:"15-min intro call, positive"},
    {type:"meeting_booked",date:"2026-02-28 16:00",detail:"Full demo Mar 5 at 11am EST"},
  ]},
  {id:7,name:"Aisha Patel",title:"VP Marketing",company:"Canva",channel:"email",status:"not_interested",lastAction:"Declined",lastActionDate:"2026-02-26",nextActionDue:null,daysInStage:6,timeline:[
    {type:"email_sent",date:"2026-02-18 10:00",detail:"Outreach: content automation"},
    {type:"email_opened",date:"2026-02-19 09:30",detail:"Opened 1 time"},
    {type:"follow_up",date:"2026-02-22 09:00",detail:"Follow-up with demo link"},
    {type:"reply_received",date:"2026-02-26 11:00",detail:"Not a priority right now, revisit Q3"},
  ]},
  {id:8,name:"Tom Richards",title:"Head of BizDev",company:"Vercel",channel:"linkedin",status:"qualified",lastAction:"Researched",lastActionDate:"2026-03-01",nextActionDue:"2026-03-03",daysInStage:1,timeline:[
    {type:"linkedin_connect",date:"2026-03-01 09:00",detail:"Connection request sent, accepted same day"},
  ]},
  {id:9,name:"Nina Kozlov",title:"Director Sales Ops",company:"MongoDB",channel:"email",status:"contacted",lastAction:"Initial email sent",lastActionDate:"2026-03-01",nextActionDue:"2026-03-04",daysInStage:1,timeline:[
    {type:"email_sent",date:"2026-03-01 08:30",detail:"Cold outreach: pipeline automation for DevTools"},
  ]},
  {id:10,name:"Chris Anderson",title:"CEO",company:"Scale AI",channel:"email",status:"bounced",lastAction:"Email bounced",lastActionDate:"2026-02-20",nextActionDue:null,daysInStage:12,timeline:[
    {type:"email_sent",date:"2026-02-20 09:00",detail:"Outreach to CEO"},
    {type:"bounced",date:"2026-02-20 09:02",detail:"Hard bounce: invalid email address"},
  ]},
  {id:11,name:"Rachel Green",title:"VP Partnerships",company:"Zapier",channel:"email",status:"replied",lastAction:"Replied",lastActionDate:"2026-02-28",nextActionDue:"2026-03-02",daysInStage:3,timeline:[
    {type:"email_sent",date:"2026-02-22 09:15",detail:"Integration partnership pitch"},
    {type:"email_opened",date:"2026-02-22 11:00",detail:"Opened 5 times"},
    {type:"follow_up",date:"2026-02-25 09:00",detail:"Follow-up with integration spec"},
    {type:"reply_received",date:"2026-02-28 15:30",detail:"Wants to explore further, looping in eng team"},
  ]},
  {id:12,name:"Alex Turner",title:"Head of RevOps",company:"Amplitude",channel:"linkedin",status:"contacted",lastAction:"LinkedIn message sent",lastActionDate:"2026-02-27",nextActionDue:"2026-03-02",daysInStage:5,timeline:[
    {type:"linkedin_connect",date:"2026-02-24 10:00",detail:"Connected"},
    {type:"linkedin_message",date:"2026-02-27 11:00",detail:"Sent message about RevOps AI agent"},
  ]},
  {id:13,name:"Priya Sharma",title:"CTO",company:"Razorpay",channel:"email",status:"qualified",lastAction:"Qualified",lastActionDate:"2026-03-01",nextActionDue:"2026-03-03",daysInStage:1,timeline:[]},
  {id:14,name:"Mike Zhang",title:"VP Sales",company:"Snowflake",channel:"email",status:"contacted",lastAction:"Second follow-up sent",lastActionDate:"2026-02-28",nextActionDue:"2026-03-04",daysInStage:6,timeline:[
    {type:"email_sent",date:"2026-02-20 09:00",detail:"Cold outreach: AI SDR for data platforms"},
    {type:"email_opened",date:"2026-02-20 14:00",detail:"Opened 1 time"},
    {type:"follow_up",date:"2026-02-24 09:00",detail:"Follow-up #1"},
    {type:"follow_up",date:"2026-02-28 09:00",detail:"Follow-up #2 with ROI data"},
  ]},
  {id:15,name:"Sophie Martin",title:"Director of Growth",company:"Notion",channel:"email",status:"opened",lastAction:"Email opened",lastActionDate:"2026-03-02",nextActionDue:"2026-03-04",daysInStage:2,timeline:[
    {type:"email_sent",date:"2026-02-28 10:00",detail:"Outreach: growth automation tools"},
    {type:"email_opened",date:"2026-03-02 08:45",detail:"Opened 2 times"},
  ]},
  {id:16,name:"Daniel Park",title:"Head of Engineering",company:"Supabase",channel:"linkedin",status:"researched",lastAction:"Added to list",lastActionDate:"2026-03-02",nextActionDue:"2026-03-04",daysInStage:0,timeline:[]},
  {id:17,name:"Hannah Wilson",title:"VP Product",company:"Linear",channel:"email",status:"qualified",lastAction:"ICP match confirmed",lastActionDate:"2026-03-01",nextActionDue:"2026-03-03",daysInStage:1,timeline:[]},
  {id:18,name:"Ben Taylor",title:"CRO",company:"PagerDuty",channel:"email",status:"contacted",lastAction:"Email sent",lastActionDate:"2026-03-01",nextActionDue:"2026-03-04",daysInStage:1,timeline:[
    {type:"email_sent",date:"2026-03-01 09:30",detail:"Outreach: incident response + AI agents"},
  ]},
  {id:19,name:"Yuki Tanaka",title:"Director of Sales",company:"Mercari",channel:"linkedin",status:"researched",lastAction:"Researching",lastActionDate:"2026-03-02",nextActionDue:"2026-03-05",daysInStage:0,timeline:[]},
  {id:20,name:"Olivia Brown",title:"Head of Demand Gen",company:"Atlassian",channel:"email",status:"opened",lastAction:"Email opened",lastActionDate:"2026-03-01",nextActionDue:"2026-03-03",daysInStage:3,timeline:[
    {type:"email_sent",date:"2026-02-26 09:00",detail:"Cold outreach: demand gen AI"},
    {type:"email_opened",date:"2026-03-01 07:30",detail:"Opened 3 times, clicked link"},
  ]},
  {id:21,name:"Kevin Lee",title:"VP Strategy",company:"Plaid",channel:"email",status:"researched",lastAction:"Added to list",lastActionDate:"2026-03-02",nextActionDue:"2026-03-04",daysInStage:0,timeline:[]},
  {id:22,name:"Maria Costa",title:"CMO",company:"Brex",channel:"linkedin",status:"qualified",lastAction:"Qualified",lastActionDate:"2026-03-01",nextActionDue:"2026-03-03",daysInStage:1,timeline:[]},
  {id:23,name:"Nathan Clarke",title:"Head of Sales",company:"Retool",channel:"email",status:"contacted",lastAction:"Initial email sent",lastActionDate:"2026-02-28",nextActionDue:"2026-03-03",daysInStage:4,timeline:[
    {type:"email_sent",date:"2026-02-28 08:45",detail:"Cold outreach: internal tools + AI"},
  ]},
  {id:24,name:"Fatima Al-Rashid",title:"Director RevOps",company:"Miro",channel:"email",status:"replied",lastAction:"Replied",lastActionDate:"2026-03-01",nextActionDue:"2026-03-03",daysInStage:2,timeline:[
    {type:"email_sent",date:"2026-02-24 10:00",detail:"Outreach: RevOps automation"},
    {type:"email_opened",date:"2026-02-24 14:30",detail:"Opened 2 times"},
    {type:"follow_up",date:"2026-02-27 09:00",detail:"Follow-up with case study"},
    {type:"reply_received",date:"2026-03-01 10:00",detail:"Interested, wants to see pricing"},
  ]},
  {id:25,name:"Ryan Foster",title:"CTO",company:"LaunchDarkly",channel:"linkedin",status:"contacted",lastAction:"LinkedIn message sent",lastActionDate:"2026-02-28",nextActionDue:"2026-03-03",daysInStage:4,timeline:[
    {type:"linkedin_connect",date:"2026-02-25 09:00",detail:"Connected"},
    {type:"linkedin_message",date:"2026-02-28 10:00",detail:"Pitch about feature flag automation"},
  ]},
  {id:26,name:"Jessica Wong",title:"VP Marketing",company:"Webflow",channel:"email",status:"not_interested",lastAction:"Unsubscribed",lastActionDate:"2026-02-25",nextActionDue:null,daysInStage:7,timeline:[
    {type:"email_sent",date:"2026-02-18 09:00",detail:"Cold outreach: marketing AI"},
    {type:"email_opened",date:"2026-02-18 16:00",detail:"Opened 1 time"},
    {type:"follow_up",date:"2026-02-22 09:00",detail:"Follow-up"},
    {type:"reply_received",date:"2026-02-25 13:00",detail:"Not interested, please remove"},
  ]},
  {id:27,name:"Carlos Mendez",title:"Head of Growth",company:"Deel",channel:"email",status:"qualified",lastAction:"ICP match",lastActionDate:"2026-03-02",nextActionDue:"2026-03-04",daysInStage:0,timeline:[]},
  {id:28,name:"Anna Petrova",title:"VP Sales",company:"JetBrains",channel:"linkedin",status:"researched",lastAction:"Researching",lastActionDate:"2026-03-02",nextActionDue:"2026-03-05",daysInStage:0,timeline:[]},
  {id:29,name:"Ibrahim Hassan",title:"Director BizDev",company:"Cloudflare",channel:"email",status:"contacted",lastAction:"Follow-up sent",lastActionDate:"2026-02-28",nextActionDue:"2026-03-03",daysInStage:5,timeline:[
    {type:"email_sent",date:"2026-02-23 09:00",detail:"Cold outreach: edge AI agents"},
    {type:"email_opened",date:"2026-02-23 15:00",detail:"Opened 2 times"},
    {type:"follow_up",date:"2026-02-28 09:00",detail:"Follow-up with technical brief"},
  ]},
  {id:30,name:"Lauren Mitchell",title:"CRO",company:"Gong",channel:"email",status:"meeting",lastAction:"Meeting scheduled",lastActionDate:"2026-03-01",nextActionDue:"2026-03-06",daysInStage:1,timeline:[
    {type:"email_sent",date:"2026-02-17 09:00",detail:"Outreach: AI sales intelligence"},
    {type:"email_opened",date:"2026-02-17 12:00",detail:"Opened 6 times"},
    {type:"reply_received",date:"2026-02-19 09:45",detail:"Very interested, tell me more"},
    {type:"follow_up",date:"2026-02-20 09:00",detail:"Sent detailed product brief"},
    {type:"call",date:"2026-02-24 14:00",detail:"30-min discovery call, strong fit"},
    {type:"meeting_booked",date:"2026-03-01 10:00",detail:"Full demo Mar 6 with VP Sales + RevOps"},
  ]},
  {id:31,name:"Derek Washington",title:"Head of Product",company:"Airtable",channel:"linkedin",status:"replied",lastAction:"LinkedIn reply",lastActionDate:"2026-03-02",nextActionDue:"2026-03-04",daysInStage:1,timeline:[
    {type:"linkedin_connect",date:"2026-02-25 10:00",detail:"Connected"},
    {type:"linkedin_message",date:"2026-02-27 09:00",detail:"Product-led growth AI pitch"},
    {type:"linkedin_reply",date:"2026-03-02 14:30",detail:"Curious about the product, send info"},
  ]},
  {id:32,name:"Eva Lindström",title:"VP Engineering",company:"Spotify",channel:"email",status:"researched",lastAction:"Added to list",lastActionDate:"2026-03-02",nextActionDue:"2026-03-04",daysInStage:0,timeline:[]},
];

const FUNNEL = [
  { key:"researched", label:"Researched", count:234, color:"bg-slate-400", tc:"text-slate-300" },
  { key:"qualified", label:"Qualified", count:89, color:"bg-blue-400", tc:"text-blue-300" },
  { key:"contacted", label:"Contacted", count:45, color:"bg-indigo-400", tc:"text-indigo-300" },
  { key:"replied", label:"Replied", count:12, color:"bg-purple-400", tc:"text-purple-300" },
  { key:"meeting", label:"Meeting", count:4, color:"bg-green-400", tc:"text-green-300" },
];

const S_CFG: Record<OutreachStatus, { label: string; cls: string }> = {
  researched:     { label:"Researched",      cls:"badge-gray"   },
  qualified:      { label:"Qualified",       cls:"badge-blue"   },
  contacted:      { label:"Contacted",       cls:"badge-yellow" },
  opened:         { label:"Opened",          cls:"badge-purple" },
  replied:        { label:"Replied",         cls:"badge-green"  },
  meeting:        { label:"Meeting",         cls:"badge bg-green-500/20 text-green-300" },
  not_interested: { label:"Not Interested",  cls:"badge-red"    },
  bounced:        { label:"Bounced",         cls:"badge-red"    },
};

const TP: Record<string, { icon: typeof Mail; color: string; label: string }> = {
  email_sent:       { icon: Mail,           color:"text-blue-400",   label:"Email Sent"          },
  email_opened:     { icon: Eye,            color:"text-yellow-400", label:"Email Opened"         },
  follow_up:        { icon: Send,           color:"text-indigo-400", label:"Follow-up Sent"       },
  reply_received:   { icon: Reply,          color:"text-green-400",  label:"Reply Received"       },
  linkedin_connect: { icon: UserCheck,      color:"text-blue-300",   label:"LinkedIn Connected"   },
  linkedin_message: { icon: MessageSquare,  color:"text-blue-400",   label:"LinkedIn Message"     },
  linkedin_reply:   { icon: Reply,          color:"text-green-400",  label:"LinkedIn Reply"       },
  call:             { icon: Phone,          color:"text-purple-400", label:"Phone Call"            },
  meeting_booked:   { icon: Calendar,       color:"text-green-300",  label:"Meeting Booked"       },
  bounced:          { icon: X,              color:"text-red-400",    label:"Bounced"              },
};

const ALL_S: OutreachStatus[] = ["researched","qualified","contacted","opened","replied","meeting","not_interested","bounced"];

function ProspectRow({ p, expanded, onToggle }: { p: Prospect; expanded: boolean; onToggle: () => void }) {
  const cfg = S_CFG[p.status];
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer">
        <td className="!pr-0">
          {p.timeline.length > 0 ? (
            expanded ? <ChevronDown size={14} className="text-apex-muted" /> : <ChevronRight size={14} className="text-apex-muted" />
          ) : <span className="w-3.5" />}
        </td>
        <td>
          <div>
            <p className="text-sm font-medium text-white">{p.name}</p>
            <p className="text-[11px] text-apex-muted">{p.title}</p>
          </div>
        </td>
        <td className="text-sm text-apex-muted">{p.company}</td>
        <td>
          {p.channel === "email" ? (
            <span className="badge-blue"><Mail size={11} /> Email</span>
          ) : (
            <span className="badge bg-sky-500/10 text-sky-400"><MessageSquare size={11} /> LinkedIn</span>
          )}
        </td>
        <td><span className={cfg.cls}>{cfg.label}</span></td>
        <td>
          <p className="text-sm text-white">{p.lastAction}</p>
          <p className="text-[10px] text-apex-muted">{p.lastActionDate}</p>
        </td>
        <td>
          {p.nextActionDue ? (
            <span className="text-sm text-apex-muted flex items-center gap-1"><Clock size={11} /> {p.nextActionDue}</span>
          ) : (
            <span className="text-xs text-apex-muted/50">\u2014</span>
          )}
        </td>
        <td className="text-right">
          <span className={cn("text-sm font-medium", p.daysInStage > 5 ? "text-yellow-400" : "text-apex-muted")}>{p.daysInStage}d</span>
        </td>
      </tr>
      {expanded && p.timeline.length > 0 && (
        <tr>
          <td colSpan={8} className="!py-0 !px-0">
            <div className="bg-white/[0.02] border-t border-b border-apex-border/30 px-8 py-4">
              <p className="text-xs font-semibold text-apex-muted uppercase tracking-wide mb-3">Activity Timeline</p>
              <div className="relative pl-6 space-y-3">
                <div className="absolute left-2 top-1 bottom-1 w-px bg-apex-border/40" />
                {p.timeline.map((tp, i) => {
                  const c = TP[tp.type] || { icon: Clock, color: "text-apex-muted", label: tp.type };
                  const Icon = c.icon;
                  return (
                    <div key={i} className="relative flex items-start gap-3">
                      <div className={cn("absolute -left-4 top-0.5 w-4 h-4 rounded-full bg-apex-surface border border-apex-border flex items-center justify-center", c.color)}>
                        <Icon size={8} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={cn("text-xs font-medium", c.color)}>{c.label}</span>
                          <span className="text-[10px] text-apex-muted">{tp.date}</span>
                        </div>
                        <p className="text-xs text-apex-muted mt-0.5">{tp.detail}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function OutreachPage() {
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [channelFilter, setChannelFilter] = useState<"all" | Channel>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | OutreachStatus>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const filtered = useMemo(() => {
    return P.filter((p) => {
      if (channelFilter !== "all" && p.channel !== channelFilter) return false;
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !p.company.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [channelFilter, statusFilter, searchQuery]);

  const total = P.length;
  const emailCt = P.filter((p) => p.channel === "email").length;
  const openedCt = P.filter((p) => p.timeline.some((t) => t.type === "email_opened")).length;
  const repliedCt = P.filter((p) => ["replied","meeting"].includes(p.status)).length;
  const meetingsCt = P.filter((p) => p.status === "meeting").length;
  const openRate = emailCt > 0 ? ((openedCt / emailCt) * 100).toFixed(1) : "0";
  const replyRate = total > 0 ? ((repliedCt / total) * 100).toFixed(1) : "0";

  return (
    <div className="p-6 lg:p-8 max-w-[1400px] mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Send size={22} className="text-apex-indigo-light" /> Outreach Tracker
          </h1>
          <p className="text-sm text-apex-muted mt-1">Track every prospect touchpoint from research to meeting</p>
        </div>
        <button onClick={() => setShowFilters(!showFilters)} className={cn("btn-ghost flex items-center gap-1.5", showFilters && "bg-white/5 text-white")}>
          <Filter size={14} /> Filters <ChevronDown size={12} className={cn("transition-transform", showFilters && "rotate-180")} />
        </button>
      </div>

      {/* Funnel */}
      <div className="card-glass">
        <h2 className="section-title mb-5 flex items-center gap-2">
          <BarChart3 size={16} className="text-apex-indigo-light" /> Outreach Funnel
        </h2>
        <div className="flex items-end gap-1 sm:gap-2" style={{ height: "160px" }}>
          {FUNNEL.map((s, i) => {
            const hPct = Math.max((s.count / FUNNEL[0].count) * 100, 10);
            return (
              <div key={s.key} className="flex items-end flex-1 gap-0.5 sm:gap-1">
                <div className="flex flex-col items-center flex-1 gap-1.5">
                  <span className="text-base sm:text-lg font-bold text-white">{s.count}</span>
                  <div className={cn("w-full rounded-t-lg transition-all duration-500", s.color)} style={{ height: `${hPct}%`, minHeight: "14px", opacity: 0.85 }} />
                  <span className={cn("text-[10px] sm:text-xs font-medium whitespace-nowrap", s.tc)}>{s.label}</span>
                </div>
                {i < FUNNEL.length - 1 && (
                  <div className="flex flex-col items-center justify-center pb-8 min-w-[32px] sm:min-w-[40px]">
                    <ArrowRight size={11} className="text-apex-muted" />
                    <span className="text-[9px] sm:text-[10px] text-apex-muted font-medium mt-0.5">
                      {((FUNNEL[i + 1].count / s.count) * 100).toFixed(0)}%
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label:"Total Outreach", value:String(total), icon:Users, sub:"+12 this week", sc:"text-green-400" },
          { label:"Open Rate", value:`${openRate}%`, icon:Eye, sub:"Email only", sc:"text-apex-muted" },
          { label:"Reply Rate", value:`${replyRate}%`, icon:TrendingUp, sub:"All channels", sc:"text-apex-muted" },
          { label:"Meetings Booked", value:String(meetingsCt), icon:Target, sub:"This month", sc:"text-green-400" },
        ].map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.label} className="kpi-card">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-apex-muted font-medium">{k.label}</span>
                <Icon size={14} className="text-apex-indigo-light" />
              </div>
              <p className="text-2xl font-bold text-white">{k.value}</p>
              <p className={cn("text-[11px] mt-1", k.sc)}>{k.sub}</p>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="card-glass animate-fade-in-up flex flex-wrap items-center gap-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-apex-muted" />
            <input type="text" placeholder="Search name or company..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="input-field w-full pl-9 py-2 text-sm" />
          </div>
          <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value as typeof channelFilter)} className="input-field text-sm py-2">
            <option value="all">All Channels</option>
            <option value="email">Email</option>
            <option value="linkedin">LinkedIn</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="input-field text-sm py-2">
            <option value="all">All Statuses</option>
            {ALL_S.map((s) => (<option key={s} value={s}>{S_CFG[s].label}</option>))}
          </select>
          {(channelFilter !== "all" || statusFilter !== "all" || searchQuery) && (
            <button onClick={() => { setChannelFilter("all"); setStatusFilter("all"); setSearchQuery(""); }} className="btn-ghost text-red-400 hover:text-red-300">Clear</button>
          )}
        </div>
      )}

      {/* Table */}
      <div className="card-glass !p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table w-full text-sm">
            <thead>
              <tr className="border-b border-apex-border/60">
                <th className="w-8"></th>
                <th>Prospect</th>
                <th>Company</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Last Action</th>
                <th>Next Due</th>
                <th className="text-right">Days</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <ProspectRow key={p.id} p={p} expanded={expandedRow === p.id} onToggle={() => setExpandedRow(expandedRow === p.id ? null : p.id)} />
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="text-center py-12 text-apex-muted">No prospects match your filters</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-apex-border/40 flex items-center justify-between">
          <span className="text-xs text-apex-muted">Showing {filtered.length} of {total} prospects</span>
        </div>
      </div>
    </div>
  );
}
