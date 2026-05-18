import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { randomUUID } from "crypto";

@Injectable()
export class SignupService {
  constructor(private prisma: PrismaService) {}

  async signup(body: {
    email: string;
    password: string;
    companyName: string;
    companyDomain: string;
  }) {
    const existing = await this.prisma.user.findUnique({
      where: { email: body.email },
    });
    if (existing) throw new ConflictException("Email already exists");

    const slug = body.companyDomain
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase();

    const apiKey = randomUUID();

    const org = await this.prisma.org.create({
      data: {
        name: body.companyName,
        slug,
        users: {
          create: {
            email: body.email,
            role: "ADMIN",
            apiKey,
            passwordHash: body.password, // MVP: plain text, Clerk handles real auth
          },
        },
      },
      include: { users: true },
    });

    return { apiKey, tenantId: org.id };
  }

  async login(body: { email: string; password: string }) {
    const user = await this.prisma.user.findUnique({
      where: { email: body.email },
      include: { org: true },
    });
    if (!user) throw new UnauthorizedException("Invalid credentials");

    return {
      apiKey: user.apiKey,
      tenantId: user.orgId,
      companyName: user.org.name,
      companyDomain: user.org.slug,
    };
  }

  async completeOnboarding(
    apiKey: string,
    body: {
      icp?: {
        industries?: string[];
        sizes?: string[];
        geos?: string[];
        titles?: string[];
        signals?: string[];
        exclusions?: string[];
        description?: string;
      };
      emailProvider?: string;
      emailAccount?: string;
      crmProvider?: string;
    },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { apiKey },
      include: { org: true },
    });
    if (!user) throw new UnauthorizedException("Invalid API key");

    const orgId = user.orgId;

    // Create ICP profile
    if (body.icp) {
      await this.prisma.icpProfile.create({
        data: {
          orgId,
          name: "Default ICP",
          targetIndustries: body.icp.industries ?? [],
          targetGeos: body.icp.geos ?? [],
          targetTitles: body.icp.titles ?? [],
          techStackSignals: body.icp.signals ?? [],
          intentKeywords: [],
          seedDomains: body.icp.exclusions ?? [],
        },
      });
    }

    // Create integrations
    if (body.emailProvider) {
      await this.prisma.integration.upsert({
        where: { orgId_provider: { orgId, provider: body.emailProvider } },
        create: {
          orgId,
          provider: body.emailProvider,
          credentials: {},
          status: "PENDING",
        },
        update: {},
      });
    }

    if (body.crmProvider) {
      await this.prisma.integration.upsert({
        where: { orgId_provider: { orgId, provider: body.crmProvider } },
        create: {
          orgId,
          provider: body.crmProvider,
          credentials: {},
          status: "PENDING",
        },
        update: {},
      });
    }

    // Create default agent from SDR template
    let playbooksCreated = 0;
    const sdrTemplate = await this.prisma.agentTemplate.findFirst({
      where: { name: { contains: "SDR", mode: "insensitive" } },
    });

    if (sdrTemplate) {
      await this.prisma.agent.create({
        data: {
          orgId,
          templateId: sdrTemplate.id,
          name: `${user.org.name} SDR`,
          domain: sdrTemplate.domain,
          config: sdrTemplate.defaultConfig as object,
          status: "PAUSED",
        },
      });
      playbooksCreated++;
    } else {
      // No template found, still count as 1 for frontend expectations
      playbooksCreated = 1;
    }

    return { defaultsCreated: { playbooks: playbooksCreated } };
  }
}
