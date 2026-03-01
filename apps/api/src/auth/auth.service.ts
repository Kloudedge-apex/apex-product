import { Injectable, NotFoundException } from "@nestjs/common";
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
  data: ClerkUserCreatedEvent | ClerkOrgCreatedEvent;
}

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) { }

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

    try {
      switch (event.type) {
        case "user.created": {
          const data = event.data as ClerkUserCreatedEvent;
          const email = data.email_addresses?.[0]?.email_address;
          if (!email) break;
          // User will be linked to an org when they join one via Clerk
          // For now, just ensure we have a record if they already have an org
          break;
        }

        case "organization.created": {
          const data = event.data as ClerkOrgCreatedEvent;
          await this.prisma.org.upsert({
            where: { slug: data.slug },
            create: { name: data.name, slug: data.slug },
            update: { name: data.name },
          });
          break;
        }

        case "organizationMembership.created": {
          // When a user joins an org, create/link their User record
          const raw = event.data as unknown as Record<string, unknown>;
          const clerkUserId = (raw.public_user_data as Record<string, unknown>)?.user_id as string;
          const orgSlug = (raw.organization as Record<string, unknown>)?.slug as string;
          const email = ((raw.public_user_data as Record<string, unknown>)?.identifier as string) || "";
          const role = (raw.role as string)?.toUpperCase() === "ORG:ADMIN" ? "ADMIN" : "MEMBER";

          if (clerkUserId && orgSlug) {
            const org = await this.prisma.org.findUnique({ where: { slug: orgSlug } });
            if (org) {
              await this.prisma.user.upsert({
                where: { clerkId: clerkUserId },
                create: { clerkId: clerkUserId, orgId: org.id, email, role: role as "ADMIN" | "MEMBER" },
                update: { orgId: org.id, role: role as "ADMIN" | "MEMBER" },
              });
            }
          }
          break;
        }

        default:
          // Unhandled event types are silently ignored
          break;
      }
    } catch {
      // Webhook handler errors should not return 5xx — Clerk will retry
    }

    return { received: true };
  }
}
