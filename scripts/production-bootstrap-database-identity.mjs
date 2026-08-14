#!/usr/bin/env node

import { createHash } from "node:crypto";

import {
  canonicalJson,
  strictJsonParse,
} from "./production-bootstrap-phase-ledger.mjs";

const HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_IDENTITY_BYTES = 16 * 1024;

export const PRODUCTION_DATABASE_IDENTITY_KEYS = Object.freeze([
  "database_name",
  "database_user",
  "database_schema",
  "server_address",
  "server_port",
  "server_version",
]);

// This is intentionally the exact row shape used by
// readProductionBootstrapDatabaseInventory. All callable objects are resolved
// from pg_catalog so a public-schema shadow cannot forge target identity.
export const PRODUCTION_DATABASE_IDENTITY_QUERY = String.raw`
SELECT pg_catalog.json_build_object(
  'database_name', pg_catalog.current_database(),
  'database_user', CURRENT_USER,
  'database_schema', pg_catalog.current_schema(),
  'server_address', COALESCE(pg_catalog.inet_server_addr()::text, 'local'),
  'server_port', pg_catalog.inet_server_port()::text,
  'server_version', pg_catalog.current_setting('server_version_num')
)::text;
`;

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(label + " must be an object");
  }
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    fail(label + " has unexpected or missing fields");
  }
}

function boundedTextOrNull(value, label, allowNull = false) {
  if (allowNull && value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(label + " is invalid");
  }
  return value;
}

export function validateProductionDatabaseIdentity(value) {
  exactKeys(value, PRODUCTION_DATABASE_IDENTITY_KEYS, "production database identity");
  boundedTextOrNull(value.database_name, "database name");
  boundedTextOrNull(value.database_user, "database user");
  boundedTextOrNull(value.database_schema, "database schema", true);
  boundedTextOrNull(value.server_address, "database server address");
  const port = boundedTextOrNull(value.server_port, "database server port", true);
  if (port !== null && (!/^\d{1,5}$/u.test(port) || Number(port) > 65535)) {
    fail("database server port is invalid");
  }
  if (typeof value.server_version !== "string" || !/^\d{5,8}$/u.test(value.server_version)) {
    fail("database server version is invalid");
  }
  return value;
}

export function productionDatabaseIdentityHash(identity) {
  validateProductionDatabaseIdentity(identity);
  return `sha256:${createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex")}`;
}

export function parseProductionDatabaseIdentityOutput(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? "");
  if (bytes.length < 2 || bytes.length > MAX_IDENTITY_BYTES) {
    fail("production database identity output byte length is invalid");
  }
  const lines = bytes.toString("utf8").split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) fail("production database identity output is ambiguous");
  return validateProductionDatabaseIdentity(
    strictJsonParse(Buffer.from(lines[0], "utf8"), "production database identity"),
  );
}

export function assertProductionDatabaseIdentityOutput(input, expectedHash) {
  if (typeof expectedHash !== "string" || !HASH.test(expectedHash)) {
    fail("expected production database identity hash is invalid");
  }
  const identity = parseProductionDatabaseIdentityOutput(input);
  if (productionDatabaseIdentityHash(identity) !== expectedHash) {
    fail("protected PostgreSQL connection does not match the admitted database identity");
  }
  return identity;
}

const SAME_SESSION_CHECKS = Object.freeze({
  database_name: "pg_catalog.to_json(pg_catalog.current_database())::text",
  database_user: "pg_catalog.to_json(CURRENT_USER)::text",
  database_schema:
    "COALESCE(pg_catalog.to_json(pg_catalog.current_schema())::text, 'null')",
  server_address:
    "pg_catalog.to_json(COALESCE(pg_catalog.inet_server_addr()::text, 'local'))::text",
  server_port:
    "COALESCE(pg_catalog.to_json(pg_catalog.inet_server_port()::text)::text, 'null')",
  server_version:
    "pg_catalog.to_json(pg_catalog.current_setting('server_version_num'))::text",
});

// Run this as a separate psql --command immediately before a --file/--command
// mutation in the same psql process. psql does not interpolate variables in
// --command, so validated JSON values are embedded as quote-free base64. A
// mismatch divides by zero and ON_ERROR_STOP prevents the following mutation.
export function productionDatabaseIdentityAssertionSql(identity) {
  validateProductionDatabaseIdentity(identity);
  const expectedJson = (value) => {
    const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    return `pg_catalog.convert_from(pg_catalog.decode('${encoded}', 'base64'), 'UTF8')`;
  };
  return "SELECT 1 / (CASE WHEN " + PRODUCTION_DATABASE_IDENTITY_KEYS.map((key) =>
    SAME_SESSION_CHECKS[key] + " = " + expectedJson(identity[key])).join(" AND ") +
    " THEN 1 ELSE 0 END) AS workforce_database_identity_verified;";
}
