export const DELIVERY_UNKNOWN_COMPATIBILITY_EPOCH =
  "outreach-delivery-unknown-v1";

export const DELIVERY_UNKNOWN_FIRST_CLASS_WRITE_ACK =
  "readers-drained-rollback-baselines-verified-v1";

export const DELIVERY_UNKNOWN_WRITE_MODE = {
  DISABLED: "disabled",
  FIRST_CLASS: "first-class",
} as const;

export type DeliveryUnknownWriteMode =
  (typeof DELIVERY_UNKNOWN_WRITE_MODE)[keyof typeof DELIVERY_UNKNOWN_WRITE_MODE];

/**
 * Resolve the only representation a worker may persist for an ambiguous
 * provider outcome. Invalid, partial, legacy, and absent configuration all
 * resolve to DISABLED so a SENDING claim cannot be silently rewritten.
 * DISABLED is not a worker or queue pause; it governs this terminal write only.
 */
export function resolveDeliveryUnknownWriteMode(
  env: NodeJS.ProcessEnv = process.env,
): DeliveryUnknownWriteMode {
  const mode = env.OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE;
  const ack = env.OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK;
  const epoch = env.OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH;

  if (
    mode === DELIVERY_UNKNOWN_WRITE_MODE.FIRST_CLASS &&
    ack === DELIVERY_UNKNOWN_FIRST_CLASS_WRITE_ACK &&
    epoch === DELIVERY_UNKNOWN_COMPATIBILITY_EPOCH
  ) {
    return DELIVERY_UNKNOWN_WRITE_MODE.FIRST_CLASS;
  }
  return DELIVERY_UNKNOWN_WRITE_MODE.DISABLED;
}
