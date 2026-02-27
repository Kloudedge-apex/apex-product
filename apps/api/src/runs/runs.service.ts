import { Injectable } from "@nestjs/common";

@Injectable()
export class RunsService {
  findAll(agentId: string, orgId: string) {
    // TODO: Prisma query scoped by agentId + orgId
    return { agentId, orgId, runs: [], message: "Runs list stub" };
  }

  findOne(id: string) {
    // TODO: Prisma findUnique with logs
    return { id, message: "Run detail stub" };
  }

  getLogs(id: string) {
    // TODO: Prisma query for run logs
    return { runId: id, logs: [], message: "Run logs stub" };
  }

  trigger(agentId: string) {
    // TODO: Queue a new run via BullMQ
    return { agentId, status: "QUEUED", message: "Run triggered stub" };
  }
}
