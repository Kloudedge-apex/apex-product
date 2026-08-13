import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OutreachArtifactStatus, MeetingStatus } from "@prisma/client";

export interface DashboardStats {
  leadsSourced: number;
  leadsQualified: number;
  emailsSent: number;
  /** Null until a durable, time-windowed reply-rate definition is available. */
  replyRate: number | null;
  meetingsBooked: number;
}

export interface ActivityEvent {
  id: string;
  kind:
    | "run_started"
    | "run_needs_approval"
    | "run_completed"
    | "run_failed"
    | "draft_created"
    | "draft_approved"
    | "draft_rejected"
    | "draft_sent"
    | "delivery_unknown"
    | "meeting_proposed"
    | "meeting_confirmed";
  text: string;
  at: string;
  leadId: string;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async stats(orgId: string): Promise<DashboardStats> {
    const [
      leadsSourced,
      leadsQualified,
      emailsSent,
      meetingsBooked,
    ] = await Promise.all([
      this.prisma.leadScore.count({ where: { orgId } }),
      this.prisma.leadScore.count({
        where: { orgId, qualifiedAt: { not: null } },
      }),
      this.prisma.outreachArtifact.count({
        where: { orgId, sentAt: { not: null } },
      }),
      this.prisma.meetingLedger.count({
        where: {
          orgId,
          status: { in: [MeetingStatus.CONFIRMED, MeetingStatus.COMPLETED] },
        },
      }),
    ]);

    return {
      leadsSourced,
      leadsQualified,
      emailsSent,
      replyRate: null,
      meetingsBooked,
    };
  }

  async activity(orgId: string, limit = 30): Promise<ActivityEvent[]> {
    const [runs, artifacts, meetings] = await Promise.all([
      this.prisma.graphRun.findMany({
        where: { orgId },
        orderBy: { startedAt: "desc" },
        take: limit,
        select: {
          id: true,
          graphName: true,
          status: true,
          needsApproval: true,
          startedAt: true,
          completedAt: true,
        },
      }),
      this.prisma.outreachArtifact.findMany({
        where: { orgId },
        orderBy: { updatedAt: "desc" },
        take: limit,
        select: {
          id: true,
          toolName: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          reviewedAt: true,
        },
      }),
      this.prisma.meetingLedger.findMany({
        where: { orgId },
        orderBy: { updatedAt: "desc" },
        take: limit,
        select: {
          id: true,
          title: true,
          status: true,
          personId: true,
          createdAt: true,
          confirmedAt: true,
        },
      }),
    ]);

    const events: ActivityEvent[] = [];

    for (const r of runs) {
      events.push({
        id: `run:${r.id}:started`,
        kind: "run_started",
        text: `Started ${r.graphName}`,
        at: r.startedAt.toISOString(),
        leadId: "",
      });
      if (r.needsApproval) {
        events.push({
          id: `run:${r.id}:needs_approval`,
          kind: "run_needs_approval",
          text: `${r.graphName} is waiting for approval`,
          at: r.startedAt.toISOString(),
          leadId: "",
        });
      }
      if (r.completedAt && r.status === "COMPLETED") {
        events.push({
          id: `run:${r.id}:completed`,
          kind: "run_completed",
          text: `${r.graphName} completed`,
          at: r.completedAt.toISOString(),
          leadId: "",
        });
      }
      if (r.completedAt && r.status === "FAILED") {
        events.push({
          id: `run:${r.id}:failed`,
          kind: "run_failed",
          text: `${r.graphName} failed`,
          at: r.completedAt.toISOString(),
          leadId: "",
        });
      }
    }

    for (const a of artifacts) {
      events.push({
        id: `artifact:${a.id}:created`,
        kind: "draft_created",
        text: `Generated outreach draft (${a.toolName})`,
        at: a.createdAt.toISOString(),
        leadId: "",
      });
      if (
        a.reviewedAt &&
        (
          [
            OutreachArtifactStatus.APPROVED,
            OutreachArtifactStatus.SENDING,
            OutreachArtifactStatus.SENT,
            OutreachArtifactStatus.SIMULATED,
            OutreachArtifactStatus.DELIVERY_UNKNOWN,
          ] as readonly OutreachArtifactStatus[]
        ).includes(a.status)
      ) {
        events.push({
          id: `artifact:${a.id}:approved`,
          kind: "draft_approved",
          text: `Approved outreach draft`,
          at: a.reviewedAt.toISOString(),
          leadId: "",
        });
      }
      if (a.status === OutreachArtifactStatus.REJECTED && a.reviewedAt) {
        events.push({
          id: `artifact:${a.id}:rejected`,
          kind: "draft_rejected",
          text: `Rejected outreach draft`,
          at: a.reviewedAt.toISOString(),
          leadId: "",
        });
      }
      if (a.status === OutreachArtifactStatus.SENT) {
        events.push({
          id: `artifact:${a.id}:sent`,
          kind: "draft_sent",
          text: "Sent approved outreach",
          at: a.updatedAt.toISOString(),
          leadId: "",
        });
      }
      if (a.status === OutreachArtifactStatus.DELIVERY_UNKNOWN) {
        events.push({
          id: `artifact:${a.id}:delivery_unknown`,
          kind: "delivery_unknown",
          text: "Outreach delivery requires reconciliation",
          at: a.updatedAt.toISOString(),
          leadId: "",
        });
      }
    }

    for (const m of meetings) {
      events.push({
        id: `meeting:${m.id}:proposed`,
        kind: "meeting_proposed",
        text: `Proposed meeting "${m.title}"`,
        at: m.createdAt.toISOString(),
        leadId: m.personId ?? "",
      });
      if (m.status === MeetingStatus.CONFIRMED && m.confirmedAt) {
        events.push({
          id: `meeting:${m.id}:confirmed`,
          kind: "meeting_confirmed",
          text: `Confirmed meeting "${m.title}"`,
          at: m.confirmedAt.toISOString(),
          leadId: m.personId ?? "",
        });
      }
    }

    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return events.slice(0, limit);
  }
}
