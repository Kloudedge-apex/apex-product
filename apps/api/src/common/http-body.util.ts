export class ResponseBodyTooLargeError extends Error {
  readonly name = "ResponseBodyTooLargeError";

  constructor(readonly maxBytes: number) {
    super(`HTTP response body exceeds ${maxBytes} bytes`);
  }
}

const DEFAULT_DRAIN_BYTES = 64 * 1024;

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Best-effort connection cleanup only.
  }
}

/** Read an external response only when its decoded stream fits the byte cap. */
export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }

  const rawLength = response.headers.get("content-length");
  if (rawLength && /^\d+$/.test(rawLength.trim())) {
    const declaredLength = Number(rawLength);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cleanup errors; the size rejection is authoritative.
      }
      throw new ResponseBodyTooLargeError(maxBytes);
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await cancelReader(reader);
      throw new ResponseBodyTooLargeError(maxBytes);
    }
    chunks.push(value);
    total += value.byteLength;
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}

/**
 * Drain at most a small prefix so retry/redirect responses can reuse their
 * connection without buffering attacker-controlled bodies.
 */
export async function drainResponseBodyWithLimit(
  response: Response,
  maxBytes = DEFAULT_DRAIN_BYTES,
): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
  } catch {
    // A reused/locked body cannot be drained; retry status remains the
    // authoritative result and this best-effort cleanup must not replace it.
    return;
  }
  if (!reader) return;

  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.byteLength;
    }
  } catch {
    return;
  } finally {
    await cancelReader(reader);
  }
}
