import { describe, expect, it, vi } from "vitest";
import {
  ResponseBodyTooLargeError,
  drainResponseBodyWithLimit,
  readResponseTextWithLimit,
} from "../http-body.util";

describe("http-body.util", () => {
  it("reads a response whose decoded body is within the cap", async () => {
    const response = new Response("hello", {
      headers: { "Content-Length": "5" },
    });
    await expect(readResponseTextWithLimit(response, 5)).resolves.toBe("hello");
  });

  it("rejects an oversized declared body before buffering it", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, {
      headers: { "Content-Length": "500001" },
    });

    await expect(readResponseTextWithLimit(response, 500_000)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects and cancels a chunked body once it crosses the cap", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    });
    const response = new Response(body);

    await expect(readResponseTextWithLimit(response, 10)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("drains only a bounded prefix of retry/redirect bodies", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
      },
      cancel,
    });
    await drainResponseBodyWithLimit(new Response(body), 10);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
