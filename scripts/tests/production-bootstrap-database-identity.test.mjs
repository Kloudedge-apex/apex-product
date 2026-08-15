#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCTION_DATABASE_IDENTITY_KEYS,
  PRODUCTION_DATABASE_IDENTITY_QUERY,
  assertProductionDatabaseIdentityOutput,
  parseProductionDatabaseIdentityOutput,
  productionDatabaseIdentityHash,
  productionDatabaseIdentityAssertionSql,
  validateProductionDatabaseIdentity,
} from "../production-bootstrap-database-identity.mjs";

const IDENTITY = Object.freeze({
  database_name: "workforce",
  database_user: "bootstrap_role",
  database_schema: "public",
  server_address: "10.20.30.40",
  server_port: "5432",
  server_version: "160003",
});
const IDENTITY_HASH =
  "sha256:519c9e5b9813b43905f069c3f5e1a1c3e35a41bff832acc944b1a6b513b93058";

test("database identity hashing matches the API runtime contract fixture", () => {
  assert.equal(productionDatabaseIdentityHash(IDENTITY), IDENTITY_HASH);
  assert.deepEqual(PRODUCTION_DATABASE_IDENTITY_KEYS, [
    "database_name",
    "database_user",
    "database_schema",
    "server_address",
    "server_port",
    "server_version",
  ]);
});

test("identity query resolves callable objects from pg_catalog", () => {
  for (const callable of [
    "json_build_object",
    "current_database",
    "current_schema",
    "inet_server_addr",
    "inet_server_port",
    "current_setting",
  ]) {
    assert.match(PRODUCTION_DATABASE_IDENTITY_QUERY, new RegExp(`pg_catalog\\.${callable}\\(`));
  }
  assert.match(PRODUCTION_DATABASE_IDENTITY_QUERY,
    /COALESCE\(pg_catalog\.inet_server_addr\(\)::text, 'local'\)/u);
  assert.doesNotMatch(PRODUCTION_DATABASE_IDENTITY_QUERY, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/u);
});

test("identity parser accepts one exact bounded row", () => {
  const output = Buffer.from(`${JSON.stringify(IDENTITY)}\n`, "utf8");
  assert.equal(JSON.stringify(parseProductionDatabaseIdentityOutput(output)), JSON.stringify(IDENTITY));
  assert.equal(
    JSON.stringify(assertProductionDatabaseIdentityOutput(output, IDENTITY_HASH)),
    JSON.stringify(IDENTITY),
  );
});

test("identity parser rejects ambiguity, drift, and additional fields", () => {
  const line = JSON.stringify(IDENTITY);
  assert.throws(() => parseProductionDatabaseIdentityOutput(`${line}\n${line}\n`), /ambiguous/u);
  assert.throws(
    () => assertProductionDatabaseIdentityOutput(
      JSON.stringify({ ...IDENTITY, database_name: "other" }),
      IDENTITY_HASH,
    ),
    /does not match/u,
  );
  assert.throws(
    () => validateProductionDatabaseIdentity({ ...IDENTITY, password: "forbidden" }),
    /unexpected or missing/u,
  );
});

test("same-session assertion embeds only validated base64 JSON literals", () => {
  const assertionSql = productionDatabaseIdentityAssertionSql(IDENTITY);
  for (const callable of ["convert_from", "decode", "to_json"]) {
    assert.match(assertionSql,
      new RegExp(`pg_catalog\\.${callable}\\(`));
  }
  assert.match(assertionSql, /1 \/ \(CASE WHEN/u);
  assert.doesNotMatch(assertionSql, /:'|--set=|bootstrap_role|10\.20\.30\.40/u);
  assert.equal((assertionSql.match(/pg_catalog\.decode\('[A-Za-z0-9+/=]+'/gu) ?? []).length,
    PRODUCTION_DATABASE_IDENTITY_KEYS.length);
});
