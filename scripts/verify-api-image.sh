#!/usr/bin/env bash

# Validate the production API/worker image without starting the service or
# requiring database/provider credentials. The same artifact serves both roles;
# runtime worker behavior is selected by environment gates after startup.

set -euo pipefail

IMAGE="${1:-}"
EXPECTED_REVISION="${2:-}"

if [[ -z "${IMAGE}" || -z "${EXPECTED_REVISION}" ]]; then
  echo "Usage: $0 <image> <expected-revision>" >&2
  exit 2
fi

CONFIGURED_USER="$(docker image inspect --format '{{.Config.User}}' "${IMAGE}")"
if [[ "${CONFIGURED_USER}" != "node" && ! "${CONFIGURED_USER}" =~ ^[1-9][0-9]*(:[0-9]+)?$ ]]; then
  echo "ERROR: image config user is not explicitly non-root: ${CONFIGURED_USER:-<empty>}" >&2
  exit 1
fi

EFFECTIVE_UID="$(docker run --rm --entrypoint node "${IMAGE}" -p 'process.getuid()')"
if [[ "${EFFECTIVE_UID}" == "0" ]]; then
  echo "ERROR: image executes as root" >&2
  exit 1
fi
EFFECTIVE_GID="$(docker run --rm --entrypoint node "${IMAGE}" -p 'process.getgid()')"
if [[ "${EFFECTIVE_GID}" == "0" ]]; then
  echo "ERROR: image executes with root group" >&2
  exit 1
fi

REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${IMAGE}")"
if [[ "${REVISION}" != "${EXPECTED_REVISION}" ]]; then
  echo "ERROR: revision label ${REVISION:-<empty>} does not match ${EXPECTED_REVISION}" >&2
  exit 1
fi

CMD_JSON="$(docker image inspect --format '{{json .Config.Cmd}}' "${IMAGE}")"
if [[ "${CMD_JSON}" != '["node","--enable-source-maps","dist/main.js"]' ]]; then
  echo "ERROR: unexpected image command: ${CMD_JSON}" >&2
  exit 1
fi

HEALTHCHECK_JSON="$(docker image inspect --format '{{json .Config.Healthcheck.Test}}' "${IMAGE}")"
if [[ "${HEALTHCHECK_JSON}" != *"/api/health/live"* ]]; then
  echo "ERROR: image healthcheck does not target process liveness" >&2
  exit 1
fi

docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  --env DATABASE_URL=postgresql://container_test:container_test@127.0.0.1:1/container_test?connect_timeout=1 \
  --interactive \
  --entrypoint node \
  "${IMAGE}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  if (process.getuid() === 0) throw new Error("runtime process is root");

  const requiredFiles = [
    "/app/dist/main.js",
    "/app/dist/app.module.js",
    "/etc/ssl/certs/ca-certificates.crt",
  ];
  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) throw new Error(`missing runtime file: ${file}`);
  }

  const forbiddenPaths = [
    "/app/src",
    "/app/apps/api/src",
    "/app/packages/db/prisma",
    "/app/node_modules/@apex/db",
    "/app/dist/ops/production-bootstrap-quiescence.cli.js",
    "/workspace",
  ];
  for (const file of forbiddenPaths) {
    if (fs.existsSync(file)) throw new Error(`build/source path leaked into runtime: ${file}`);
  }

  const runtimeModules = [
    "@nestjs/core",
    "@prisma/client",
    "@langchain/langgraph",
    "@opentelemetry/sdk-node",
    "bullmq",
    "googleapis",
  ];
  for (const name of runtimeModules) require.resolve(name);

  const prismaClientDir = fs.realpathSync(path.dirname(require.resolve("@prisma/client/package.json")));
  const generatedDir = path.join(prismaClientDir, "..", "..", ".prisma", "client");
  const engines = fs
    .readdirSync(generatedDir)
    .filter((name) => /^libquery_engine-.*\.node$/.test(name));
  if (engines.length !== 1) {
    throw new Error(`expected one Prisma native query engine, found ${engines.length}`);
  }

  const { PrismaClient } = require("@prisma/client");
  if (typeof PrismaClient !== "function") throw new Error("generated Prisma client is unavailable");

  const forbiddenModules = [
    "@apex/db",
    "@nestjs/cli",
    "prisma",
    "tsx",
    "typescript",
    "vitest",
  ];
  for (const name of forbiddenModules) {
    try {
      require.resolve(name);
      throw new Error(`development dependency is runtime-resolvable: ${name}`);
    } catch (error) {
      if (error && error.code === "MODULE_NOT_FOUND") continue;
      throw error;
    }
  }

  try {
    fs.writeFileSync("/app/.write-probe", "must fail");
    throw new Error("read-only application filesystem accepted a write");
  } catch (error) {
    if (!error || !["EACCES", "EROFS"].includes(error.code)) throw error;
  }
  fs.writeFileSync("/tmp/write-probe", "ok");
  fs.unlinkSync("/tmp/write-probe");

  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    throw new Error("closed-loopback Prisma connection unexpectedly succeeded");
  } catch (error) {
    const prismaCode = error && (error.code || error.errorCode);
    if (prismaCode !== "P1001") {
      throw new Error(`Prisma native engine did not reach expected P1001: ${error}`);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`Runtime dependency and native-engine closure verified (${engines[0]}).`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  --entrypoint openssl \
  "${IMAGE}" version

set +e
DEFAULT_OUTPUT="$(docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  "${IMAGE}" 2>&1)"
DEFAULT_STATUS=$?
set -e

if [[ ${DEFAULT_STATUS} -eq 0 ]]; then
  echo "ERROR: default command succeeded without required configuration" >&2
  exit 1
fi
if [[ "${DEFAULT_OUTPUT}" != *"DATABASE_URL is required"* ]]; then
  echo "ERROR: default command did not reach fail-closed environment validation" >&2
  echo "${DEFAULT_OUTPUT}" >&2
  exit 1
fi

echo "Image contract verified: ${IMAGE} (uid=${EFFECTIVE_UID}, gid=${EFFECTIVE_GID}, revision=${REVISION})"
