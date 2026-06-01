import { describe, it, expect, vi } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { PendingWrite } from "@langchain/langgraph-checkpoint";
import type { PrismaService } from "../../prisma/prisma.service";
import { PrismaCheckpointSaver } from "../prisma-checkpointer";

describe("PrismaCheckpointSaver.putWrites", () => {
  it("rejects when prisma.graphCheckpointWrite.upsert throws", async () => {
    const upsertMock = vi.fn().mockRejectedValueOnce(new Error("db down"));

    const saver = new PrismaCheckpointSaver({
      graphCheckpointWrite: { upsert: upsertMock },
    } as unknown as PrismaService);

    const config: RunnableConfig = {
      configurable: {
        thread_id: "thread-1",
        checkpoint_ns: "",
        checkpoint_id: "checkpoint-1",
      },
    };

    const writes: PendingWrite[] = [["goto", { next: "stage-a" }]];

    await expect(saver.putWrites(config, writes, "task-1")).rejects.toThrow(
      "db down",
    );
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});

