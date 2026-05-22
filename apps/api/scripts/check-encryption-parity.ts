#!/usr/bin/env tsx
/**
 * Compare ENCRYPTION_KEY fingerprints between two Azure Container Apps to
 * catch the divergence case where api and worker can no longer encrypt /
 * decrypt the same ciphertext.
 *
 *   pnpm tsx apps/api/scripts/check-encryption-parity.ts <app-a> <app-b>
 *
 * Defaults to apex-gtm-api and apex-gtm-worker in resource group Ledgr-prod.
 *
 * Requires `az` CLI with Reader rights on the apps. Never prints the key.
 * Exits 0 on parity, 1 on mismatch, 2 on retrieval failure.
 */
import { execFileSync } from "child_process";
import { fingerprintFor } from "../src/common/env-validation";

const RESOURCE_GROUP = process.env.RG ?? "Ledgr-prod";

function getEncryptionKeyFromContainerApp(appName: string): string {
  // Try secret first, then plaintext env var. `--query` returns the literal
  // string (possibly empty); we trim and validate before fingerprinting.
  try {
    const secret = execFileSync(
      "az",
      [
        "containerapp",
        "secret",
        "show",
        "--name",
        appName,
        "--resource-group",
        RESOURCE_GROUP,
        "--secret-name",
        "encryption-key",
        "--query",
        "value",
        "-o",
        "tsv",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (secret) return secret;
  } catch {
    // fall through to env-var read
  }

  const envValue = execFileSync(
    "az",
    [
      "containerapp",
      "show",
      "--name",
      appName,
      "--resource-group",
      RESOURCE_GROUP,
      "--query",
      "properties.template.containers[0].env[?name=='ENCRYPTION_KEY'].value | [0]",
      "-o",
      "tsv",
    ],
    { encoding: "utf8" },
  ).trim();

  if (!envValue) {
    throw new Error(`ENCRYPTION_KEY not found on ${appName}`);
  }
  return envValue;
}

function main(): number {
  const [, , appA = "apex-gtm-api", appB = "apex-gtm-worker"] = process.argv;
  try {
    const keyA = getEncryptionKeyFromContainerApp(appA);
    const keyB = getEncryptionKeyFromContainerApp(appB);
    const fpA = fingerprintFor(keyA);
    const fpB = fingerprintFor(keyB);

    // eslint-disable-next-line no-console
    console.log(`${appA}: fingerprint=${fpA}  length=${keyA.length}`);
    // eslint-disable-next-line no-console
    console.log(`${appB}: fingerprint=${fpB}  length=${keyB.length}`);

    if (fpA === fpB && keyA.length === keyB.length) {
      // eslint-disable-next-line no-console
      console.log("OK — fingerprints match");
      return 0;
    }
    // eslint-disable-next-line no-console
    console.error("MISMATCH — api and worker would fail to share encrypted state");
    return 1;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Could not check parity: ${(err as Error).message}`);
    return 2;
  }
}

process.exit(main());
