import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

interface DiscoveredPerson {
  firstName: string;
  lastName: string;
  githubHandle?: string;
  linkedinUrl?: string;
  linkedinSlug?: string;
}

interface GithubOrg {
  login: string;
  id: number;
  description?: string;
}

interface GithubRepo {
  name: string;
  full_name: string;
  default_branch?: string;
}

interface GithubCommit {
  commit: {
    author?: { name?: string; email?: string };
    committer?: { name?: string; email?: string };
  };
  author?: { login?: string };
}

@Injectable()
export class GithubEnrichment {
  private readonly logger = new Logger(GithubEnrichment.name);
  private readonly token: string | undefined;
  private lastRequestTime = 0;

  constructor(private readonly config: ConfigService) {
    this.token = this.config.get<string>("GITHUB_TOKEN");
  }

  async discoverPeople(domain: string): Promise<DiscoveredPerson[]> {
    if (!this.token) {
      this.logger.debug("GITHUB_TOKEN not configured, skipping GitHub enrichment");
      return [];
    }

    const people: DiscoveredPerson[] = [];
    const seen = new Set<string>();

    try {
      // Search for GitHub orgs matching the domain
      const orgs = await this.searchOrgs(domain);

      for (const org of orgs.slice(0, 3)) {
        // Get repos for each org
        const repos = await this.getOrgRepos(org.login);

        for (const repo of repos.slice(0, 5)) {
          // Get recent commits and extract emails matching domain
          const commits = await this.getRecentCommits(repo.full_name);

          for (const commit of commits) {
            const email = commit.commit.author?.email ?? commit.commit.committer?.email;
            const name = commit.commit.author?.name ?? commit.commit.committer?.name;
            const ghLogin = commit.author?.login;

            if (!email || !name) continue;
            if (!email.endsWith(`@${domain}`)) continue;

            const key = email.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            const parts = name.split(/\s+/);
            if (parts.length < 2) continue;

            people.push({
              firstName: parts[0]!,
              lastName: parts.slice(1).join(" "),
              githubHandle: ghLogin,
            });
          }
        }
      }
    } catch (err) {
      this.logger.warn(`GitHub enrichment failed for ${domain}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return people;
  }

  /** Get committer emails matching a domain from public commits */
  async getCommitterEmails(domain: string): Promise<Array<{ email: string; name: string; githubHandle?: string }>> {
    if (!this.token) return [];

    const results: Array<{ email: string; name: string; githubHandle?: string }> = [];
    const seen = new Set<string>();

    const orgs = await this.searchOrgs(domain);
    for (const org of orgs.slice(0, 2)) {
      const repos = await this.getOrgRepos(org.login);
      for (const repo of repos.slice(0, 3)) {
        const commits = await this.getRecentCommits(repo.full_name);
        for (const c of commits) {
          const email = c.commit.author?.email;
          const name = c.commit.author?.name;
          if (!email || !name || !email.endsWith(`@${domain}`)) continue;
          if (seen.has(email)) continue;
          seen.add(email);
          results.push({ email, name, githubHandle: c.author?.login });
        }
      }
    }

    return results;
  }

  private async searchOrgs(domain: string): Promise<GithubOrg[]> {
    const domainName = domain.replace(/\.[^.]+$/, '');
    const variants = [domainName, `${domainName}hq`, `${domainName}-inc`, `${domainName}app`];
    const allOrgs: GithubOrg[] = [];
    const seen = new Set<number>();

    for (const variant of variants.slice(0, 3)) {
      const res = await this.ghFetch(
        `https://api.github.com/search/users?q=${encodeURIComponent(variant)}+type:org&per_page=5`,
      );
      if (!res.ok) continue;
      const data = await res.json() as { items?: GithubOrg[] };
      for (const org of data.items ?? []) {
        if (!seen.has(org.id)) { seen.add(org.id); allOrgs.push(org); }
      }
      if (allOrgs.length >= 5) break;
    }
    return allOrgs.slice(0, 5);
  }

  private async getOrgRepos(org: string): Promise<GithubRepo[]> {
    const res = await this.ghFetch(
      `https://api.github.com/orgs/${org}/repos?sort=pushed&per_page=10`,
    );
    if (!res.ok) return [];
    return (await res.json()) as GithubRepo[];
  }

  private async getRecentCommits(repoFullName: string): Promise<GithubCommit[]> {
    const res = await this.ghFetch(
      `https://api.github.com/repos/${repoFullName}/commits?per_page=30`,
    );
    if (!res.ok) return [];
    return (await res.json()) as GithubCommit[];
  }

  private async ghFetch(url: string): Promise<Response> {
    // Rate limit: ~1 req/sec
    const now = Date.now();
    const wait = Math.max(0, 1000 - (now - this.lastRequestTime));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestTime = Date.now();

    return fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "WorkforceOS/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10000),
    });
  }
}
