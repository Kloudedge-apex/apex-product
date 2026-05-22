// Test-only env defaults. Injected before any spec imports run, so modules
// that validate env at import time (encryption, gmail, hubspot) get a stable
// value. Real prod env is enforced at app boot via env-validation.ts; this
// file only affects vitest.

if (!process.env.ENCRYPTION_KEY) {
  // Deterministic 64-hex-char dummy key (32 bytes). Never used in prod.
  process.env.ENCRYPTION_KEY =
    "0".repeat(64);
}

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}
