import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

interface ClerkUserCreatedEvent {
  id: string;
  email_addresses: Array<{ email_address: string }>;
  first_name?: string;
  last_name?: string;
}

interface ClerkOrgCreatedEvent {
  id: string;
  name: string;
  slug: string;
}

interface ClerkWebhookEvent {
  type: string;
  data: ClerkUserCreatedEvent | ClerkOrgCreatedEvent | Record<string, unknown>;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private prisma: PrismaService) {}

  async getUserByClerkId(clerkId: string) {
    const user = await this.prisma.user.findUnique({
      where: { clerkId },
      include: { org: { select: { id: true, name: true, slug: true, plan: true } } },
    });
    if (!user) throw new NotFoundException("User not found");
    return user;
  }

  async handleWebhook(body: unknown) {
    const event = body as ClerkWebhookEvent;
    if (!event?.type) return { received: true };

    switch (event.type) {
      case "user.created":
        // User<->org linkage happens on organizationMembership.created.
        return { received: true };

      case "organization.created": {
        const data = event.data as ClerkOrgCreatedEvent;
        if (!data.slug || !data.name) {
          this.logger.warn("organization.created missing slug/name");
          return { received: true };
        }
        await this.prisma.org.upsert({
          where: { slug: data.slug },
          create: { name: data.name, slug: data.slug },
          update: { name: data.name },
        });
        return { received: true };
      }

      case "organizationMembership.created": {
        const raw = event.data as Record<string, unknown>;
        const publicUserData = raw.public_user_data as Record<string, unknown> | undefined;
        const organization = raw.organization as Record<string, unknown> | undefined;

        const clerkUserId =
          (publicUserData?.user_id as string | undefined) ??
          (raw.user_id as string | undefined);
        const orgSlug = organization?.slug as string | undefined;
        const email = (publicUserData?.identifier as string | undefined) ?? "";
        const rawRole = (raw.role as string | undefined)?.toUpperCase() ?? "";
        const role: "ADMIN" | "MEMBER" =
          rawRole === "ORG:ADMIN" || rawRole === "ADMIN" ? "ADMIN" : "MEMBER";

        if (!clerkUserId || !orgSlug) {
          this.logger.warn(
            "organizationMembership.created missing user_id or org slug; skipping",
          );
          return { received: true };
        }

        const org = await this.prisma.org.findUnique({ where: { slug: orgSlug } });
        if (!org) {
          this.logger.warn(
            `organizationMembership.created references unknown org slug ${orgSlug}`,
          );
          return { received: true };
        }

        await this.prisma.user.upsert({
          where: { clerkId: clerkUserId },
          create: { clerkId: clerkUserId, orgId: org.id, email, role },
          update: { orgId: org.id, role },
        });
        return { received: true };
      }

      default:
        return { received: true };
    }
  }
}
