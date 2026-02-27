import { Injectable } from "@nestjs/common";

@Injectable()
export class IntegrationsService {
  findAll(orgId: string) {
    // TODO: Prisma query scoped by orgId
    return { orgId, integrations: [], message: "Integrations list stub" };
  }

  connect(data: { orgId: string; provider: string }) {
    // TODO: Initiate OAuth flow for provider
    return { ...data, status: "PENDING", message: "Integration connect stub" };
  }

  disconnect(id: string) {
    // TODO: Revoke integration
    return { id, status: "REVOKED", message: "Integration disconnected stub" };
  }
}
