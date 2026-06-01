import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Plan } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EvidenceLedgerService } from "../observability/evidence-ledger.service";
import { isIP } from "node:net";

/**
 * Optional best-effort LangSmith handle. We keep the interface here (instead of
 * pulling in the real service type) so OrgsModule doesn't have to import the
 * full observability stack — the deletion path treats every external purge as
 * best-effort and only logs failures.
 */
export interface LangSmithPurgeClient {
  /**
   * Delete every run tagged with the given orgId from the LangSmith project.
   * Implementations should swallow individual page failures and resolve with
   * the count of runs they confirmed deleted.
   */
  deleteRunsByOrgTag(orgId: string): Promise<number>;
}

export const LANGSMITH_PURGE_CLIENT = Symbol("LANGSMITH_PURGE_CLIENT");

/**
 * Optional best-effort BullMQ queue scrubber. Same rationale as above.
 */
export interface GraphRunQueueScrubber {
  removeJobsByOrg(orgId: string): Promise<number>;
}

export const GRAPH_RUN_QUEUE_SCRUBBER = Symbol("GRAPH_RUN_QUEUE_SCRUBBER");

@Injectable()
export class OrgsService {
  private readonly logger = new Logger(OrgsService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() private readonly evidenceLedger?: EvidenceLedgerService,
    @Optional()
    @Inject(LANGSMITH_PURGE_CLIENT)
    private readonly langsmithPurge?: LangSmithPurgeClient,
    @Optional()
    @Inject(GRAPH_RUN_QUEUE_SCRUBBER)
    private readonly queueScrubber?: GraphRunQueueScrubber,
  ) {}

  async create(data: {
    name: string;
    slug?: string;
    clerkUserId: string;
    email: string;
    userName?: string;
  }) {
    const slug =
      data.slug ||
      data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") +
        "-" +
        Date.now().toString(36);

    const existingUser = await this.prisma.user.findUnique({
      where: { clerkId: data.clerkUserId },
    });
    if (existingUser) {
      const org = await this.prisma.org.findUnique({
        where: { id: existingUser.orgId },
        include: { users: true },
      });
      return org;
    }

    // Clerk's default JWT template omits the email claim, so `data.email` is
    // often "". User.email is @unique, so reuse-of-empty-string would collide
    // across users. Fall back to a deterministic per-user placeholder.
    const email =
      data.email && data.email.length > 0
        ? data.email
        : `${data.clerkUserId}@no-email.workforceos.local`;

    return this.prisma.org.create({
      data: {
        name: data.name,
        slug,
        plan: "TRIAL",
        trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        users: {
          create: {
            email,
            name: data.userName || data.name,
            role: "OWNER",
            clerkId: data.clerkUserId,
          },
        },
      },
      include: { users: true },
    });
  }

  async findOne(id: string) {
    const org = await this.prisma.org.findUnique({
      where: { id },
      include: { users: true, agents: true, integrations: true },
    });
    if (!org) throw new NotFoundException("Org not found");
    return org;
  }

  async findByClerkUser(clerkId: string) {
    const user = await this.prisma.user.findUnique({
      where: { clerkId },
      include: { org: { include: { agents: true, integrations: true } } },
    });
    if (!user) return null;
    return user.org;
  }

  async update(id: string, data: { name?: string; plan?: string; website?: string }) {
    const website =
      data.website === undefined
        ? undefined
        : data.website.trim().length === 0
          ? null
          : validateOrgWebsiteOrThrow(data.website);

    return this.prisma.org.update({
      where: { id },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.plan && { plan: data.plan as Plan }),
        ...(website !== undefined && { website }),
      },
    });
  }

  /**
   * GDPR Art. 17 right-to-erasure / CCPA §1798.105 deletion request.
   *
   * Order of operations:
   *   1. In a single $transaction: snapshot child-row counts, then delete the
   *      Org. The schema's onDelete: Cascade fan-out wipes User, Agent,
   *      Integration, AgentRun, GraphRun, EvidenceEvent, etc. — every model
   *      that points at Org with Cascade.
   *   2. Emit a structured logger.log() line BEFORE we touch the ledger. The
   *      Container Apps log sink is the only durable audit trail that
   *      survives the cascade, because EvidenceEvent.org is itself Cascade.
   *   3. Best-effort ledger append (will normally fail with FK violation
   *      because the org row is gone — we swallow that), best-effort
   *      LangSmith purge by tag, best-effort BullMQ scrub by orgId.
   *
   * @returns the snapshot of child counts the caller can return for audit logs.
   */
  async deleteOrg(
    orgId: string,
    actor: { userId: string; email: string | null },
  ): Promise<{
    orgId: string;
    orgName: string;
    childCounts: {
      users: number;
      agents: number;
      integrations: number;
      agentRuns: number;
      graphRuns: number;
    };
  }> {
    const orgRecord = await this.prisma.org.findUnique({
      where: { id: orgId },
      select: { id: true, name: true },
    });
    if (!orgRecord) throw new NotFoundException("Org not found");

    const snapshot = await this.prisma.$transaction(async (tx) => {
      const [users, agents, integrations, agentRuns, graphRuns] = await Promise.all([
        tx.user.count({ where: { orgId } }),
        tx.agent.count({ where: { orgId } }),
        tx.integration.count({ where: { orgId } }),
        tx.agentRun.count({ where: { orgId } }),
        tx.graphRun.count({ where: { orgId } }),
      ]);

      await tx.org.delete({ where: { id: orgId } });

      return { users, agents, integrations, agentRuns, graphRuns };
    });

    // Authoritative audit trail. Structured payload so log-based alerts and
    // forensic queries can pivot on `event=tenant.deletion`. Lives outside
    // Postgres so the cascade can't erase it.
    this.logger.log(
      JSON.stringify({
        event: "tenant.deletion",
        org_id: orgId,
        org_name: orgRecord.name,
        deleted_by_user_id: actor.userId,
        deleted_by_email: actor.email,
        child_counts: snapshot,
        ts: new Date().toISOString(),
      }),
    );

    // Best-effort: append to the ledger. EvidenceEvent.org has onDelete:
    // Cascade so this insert will likely fail with a FK violation now that
    // the Org row is gone — that's fine, the log line above is the audit
    // record. The append() helper already swallows + warn-logs on failure.
    if (this.evidenceLedger) {
      try {
        await this.evidenceLedger.orgDeleted({
          orgId,
          orgName: orgRecord.name,
          deletedByUserId: actor.userId,
          deletedByEmail: actor.email,
          childCounts: snapshot,
        });
      } catch (err) {
        this.logger.warn(
          `EvidenceLedger.orgDeleted failed (expected after cascade): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Best-effort: ask LangSmith to drop every traced run tagged with this
    // orgId. There is no first-class delete-by-tag in the SDK, so the
    // adapter is expected to page through and delete individually.
    if (this.langsmithPurge) {
      try {
        const deleted = await this.langsmithPurge.deleteRunsByOrgTag(orgId);
        this.logger.log(
          `LangSmith purge for org=${orgId} removed ${deleted} runs`,
        );
      } catch (err) {
        this.logger.warn(
          `LangSmith purge failed for org=${orgId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Best-effort: remove queued/active BullMQ jobs for this org. Workers
    // would otherwise pick up an in-flight job, fail to load its GraphRun
    // (now gone), and retry forever.
    if (this.queueScrubber) {
      try {
        const removed = await this.queueScrubber.removeJobsByOrg(orgId);
        this.logger.log(
          `Queue scrub for org=${orgId} removed ${removed} jobs`,
        );
      } catch (err) {
        this.logger.warn(
          `Queue scrub failed for org=${orgId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      orgId,
      orgName: orgRecord.name,
      childCounts: snapshot,
    };
  }

  async getStats(orgId: string) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const [
      activeAgents,
      pausedAgents,
      totalAgents,
      totalRuns,
      runsToday,
      runsThisWeek,
      completedRuns,
      integrationCount,
      tokenAgg,
      tokenTodayAgg,
      costAgg,
      costTodayAgg,
    ] = await Promise.all([
      this.prisma.agent.count({ where: { orgId, status: "ACTIVE" } }),
      this.prisma.agent.count({ where: { orgId, status: "PAUSED" } }),
      this.prisma.agent.count({ where: { orgId } }),
      this.prisma.agentRun.count({ where: { orgId } }),
      this.prisma.agentRun.count({ where: { orgId, startedAt: { gte: todayStart } } }),
      this.prisma.agentRun.count({ where: { orgId, startedAt: { gte: weekStart } } }),
      this.prisma.agentRun.count({ where: { orgId, status: "COMPLETED" } }),
      this.prisma.integration.count({ where: { orgId, status: "CONNECTED" } }),
      this.prisma.agentRun.aggregate({ where: { orgId }, _sum: { tokensUsed: true } }),
      this.prisma.agentRun.aggregate({
        where: { orgId, startedAt: { gte: todayStart } },
        _sum: { tokensUsed: true },
      }),
      this.prisma.agentRun.aggregate({ where: { orgId }, _sum: { cost: true } }),
      this.prisma.agentRun.aggregate({
        where: { orgId, startedAt: { gte: todayStart } },
        _sum: { cost: true },
      }),
    ]);

    const successRate = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0;

    const runsByDayRaw: Array<{ day: string; status: string; cnt: string }> = await this.prisma
      .$queryRaw`
      SELECT date_trunc('day', "startedAt")::date::text as day, status, COUNT(*)::text as cnt
      FROM "AgentRun"
      WHERE "orgId" = ${orgId} AND "startedAt" >= ${weekStart}
      GROUP BY day, status ORDER BY day ASC
    `;

    const dayMap = new Map<
      string,
      { date: string; total: number; completed: number; failed: number }
    >();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(todayStart);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split("T")[0];
      dayMap.set(key, { date: key, total: 0, completed: 0, failed: 0 });
    }
    for (const row of runsByDayRaw) {
      const entry = dayMap.get(row.day);
      if (entry) {
        const count = parseInt(row.cnt);
        entry.total += count;
        if (row.status === "COMPLETED") entry.completed += count;
        if (row.status === "FAILED") entry.failed += count;
      }
    }
    const runsByDay = Array.from(dayMap.values());

    const tokensByDayRaw: Array<{ day: string; tokens: string; cost: string }> = await this.prisma
      .$queryRaw`
      SELECT date_trunc('day', "startedAt")::date::text as day,
             COALESCE(SUM("tokensUsed"), 0)::text as tokens,
             COALESCE(SUM(cost), 0)::text as cost
      FROM "AgentRun"
      WHERE "orgId" = ${orgId} AND "startedAt" >= ${weekStart}
      GROUP BY day ORDER BY day ASC
    `;

    const tokenDayMap = new Map<string, { date: string; tokens: number; cost: number }>();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(todayStart);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split("T")[0];
      tokenDayMap.set(key, { date: key, tokens: 0, cost: 0 });
    }
    for (const row of tokensByDayRaw) {
      const entry = tokenDayMap.get(row.day);
      if (entry) {
        entry.tokens = parseInt(row.tokens);
        entry.cost = parseFloat(row.cost);
      }
    }
    const tokensByDay = Array.from(tokenDayMap.values());

    const topAgentsRaw: Array<{
      id: string;
      name: string;
      domain: string;
      runs: string;
      completed: string;
      tokens: string;
    }> = await this.prisma.$queryRaw`
      SELECT a.id, a.name, a.domain::text,
             COUNT(r.id)::text as runs,
             COUNT(CASE WHEN r.status = 'COMPLETED' THEN 1 END)::text as completed,
             COALESCE(AVG(r."tokensUsed"), 0)::text as tokens
      FROM "Agent" a LEFT JOIN "AgentRun" r ON r."agentId" = a.id AND r."startedAt" >= ${weekStart}
      WHERE a."orgId" = ${orgId}
      GROUP BY a.id, a.name, a.domain
      ORDER BY runs DESC LIMIT 5
    `;

    const topAgents = topAgentsRaw.map((a) => ({
      id: a.id,
      name: a.name,
      domain: a.domain,
      runs: parseInt(a.runs),
      successRate:
        parseInt(a.runs) > 0
          ? Math.round((parseInt(a.completed) / parseInt(a.runs)) * 100)
          : 0,
      avgTokens: Math.round(parseFloat(a.tokens)),
    }));

    const recentFailures = await this.prisma.agentRun.findMany({
      where: { orgId, status: "FAILED" },
      include: {
        agent: { select: { name: true } },
        logs: { where: { level: "ERROR" }, take: 1, orderBy: { createdAt: "desc" } },
      },
      orderBy: { startedAt: "desc" },
      take: 5,
    });
    const recentFailuresMapped = recentFailures.map((f) => ({
      runId: f.id,
      agentName: f.agent.name,
      error: f.logs[0]?.message || "Unknown error",
      timestamp: f.startedAt.toISOString(),
    }));

    const domainCounts = await this.prisma.agent.groupBy({
      by: ["domain"],
      where: { orgId },
      _count: true,
    });
    const agentsByDomain: Record<string, number> = { SALES: 0, MARKETING: 0, OPS: 0 };
    for (const d of domainCounts) agentsByDomain[d.domain] = d._count;

    const domainRunCounts: Array<{ domain: string; cnt: string }> = await this.prisma.$queryRaw`
      SELECT a.domain::text, COUNT(r.id)::text as cnt
      FROM "Agent" a LEFT JOIN "AgentRun" r ON r."agentId" = a.id AND r."startedAt" >= ${weekStart}
      WHERE a."orgId" = ${orgId}
      GROUP BY a.domain
    `;
    const runsByDomain: Record<string, number> = { SALES: 0, MARKETING: 0, OPS: 0 };
    for (const d of domainRunCounts) runsByDomain[d.domain] = parseInt(d.cnt);

    return {
      activeAgents,
      pausedAgents,
      totalAgents,
      totalRuns,
      runsToday,
      runsThisWeek,
      successRate,
      integrations: integrationCount,
      tokensUsed: tokenAgg._sum.tokensUsed || 0,
      tokensToday: tokenTodayAgg._sum.tokensUsed || 0,
      totalCost: costAgg._sum.cost || 0,
      costToday: costTodayAgg._sum.cost || 0,
      runsByDay,
      tokensByDay,
      topAgents,
      recentFailures: recentFailuresMapped,
      agentsByDomain,
      runsByDomain,
    };
  }
}

function validateOrgWebsiteOrThrow(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch (err) {
    throw new BadRequestException(
      `Invalid website URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (url.protocol !== "https:") {
    throw new BadRequestException("Org website must start with https://");
  }

  if (!url.hostname) {
    throw new BadRequestException("Org website must include a hostname");
  }

  if (url.username || url.password) {
    throw new BadRequestException("Org website must not include username/password");
  }

  const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
  if (hostname === "localhost") {
    throw new BadRequestException("Org website hostname must be a public domain");
  }

  if (isIP(hostname) !== 0) {
    throw new BadRequestException("Org website must not use an IP address");
  }

  if (!hostname.includes(".")) {
    throw new BadRequestException("Org website must be a public domain with a TLD");
  }

  const labels = hostname.split(".").filter((x) => x.length > 0);
  const tld = labels[labels.length - 1] ?? "";
  if (!/^[a-z]{2,63}$/.test(tld)) {
    throw new BadRequestException("Org website must have a valid public TLD");
  }

  const blockedTlds = new Set([
    "local",
    "localhost",
    "internal",
    "intranet",
    "lan",
    "home",
    "corp",
    "localdomain",
    "test",
    "example",
    "invalid",
  ]);
  if (blockedTlds.has(tld)) {
    throw new BadRequestException("Org website must use a public TLD");
  }

  return url.toString();
}
