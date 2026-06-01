import { Logger } from "@nestjs/common";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointListOptions,
  CheckpointTuple,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
} from "@langchain/langgraph-checkpoint";
import {
  CheckpointMetadata,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { SerializerProtocol } from "@langchain/langgraph-checkpoint";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Postgres-backed LangGraph checkpoint saver. Mirrors the structure of the
 * stock MemorySaver but persists to GraphCheckpoint / GraphCheckpointWrite
 * via Prisma. Thread = `threadId`, namespace defaults to "".
 *
 * State is stored as `Bytes` plus a `type` hint (the serde format, usually
 * "json"). Reads round-trip through `serde.loadsTyped(type, bytes)` so we
 * stay compatible with whatever serializer LangGraph plugs in.
 */
export class PrismaCheckpointSaver extends BaseCheckpointSaver {
  private readonly logger = new Logger(PrismaCheckpointSaver.name);

  constructor(
    private readonly prisma: PrismaService,
    serde?: SerializerProtocol,
  ) {
    super(serde);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) return undefined;
    const checkpointNs = (config.configurable?.checkpoint_ns as string) ?? "";
    const checkpointId = getCheckpointId(config);

    const row = checkpointId
      ? await this.prisma.graphCheckpoint.findUnique({
          where: {
            threadId_checkpointNamespace_checkpointId: {
              threadId,
              checkpointNamespace: checkpointNs,
              checkpointId,
            },
          },
        })
      : await this.prisma.graphCheckpoint.findFirst({
          where: { threadId, checkpointNamespace: checkpointNs },
          orderBy: { checkpointId: "desc" },
        });

    if (!row) return undefined;

    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      new Uint8Array(row.checkpoint),
    )) as Checkpoint;
    const metadata = (row.metadata as CheckpointMetadata) ?? {};

    const writes = await this.prisma.graphCheckpointWrite.findMany({
      where: {
        threadId,
        checkpointNamespace: checkpointNs,
        checkpointId: row.checkpointId,
      },
      orderBy: [{ taskId: "asc" }, { idx: "asc" }],
    });

    const pendingWrites = await Promise.all(
      writes.map(async (w) => {
        const value = await this.serde.loadsTyped(
          w.type ?? "json",
          new Uint8Array(w.value),
        );
        return [w.taskId, w.channel, value] as [string, string, unknown];
      }),
    );

    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: row.checkpointId,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };
    if (row.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: row.parentCheckpointId,
        },
      };
    }
    return tuple;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) return;
    const checkpointNs = (config.configurable?.checkpoint_ns as string) ?? "";
    const beforeId = options?.before?.configurable?.checkpoint_id as
      | string
      | undefined;

    const rows = await this.prisma.graphCheckpoint.findMany({
      where: {
        threadId,
        checkpointNamespace: checkpointNs,
        ...(beforeId ? { checkpointId: { lt: beforeId } } : {}),
      },
      orderBy: { checkpointId: "desc" },
      take: options?.limit ?? undefined,
    });

    for (const row of rows) {
      const checkpoint = (await this.serde.loadsTyped(
        row.type ?? "json",
        new Uint8Array(row.checkpoint),
      )) as Checkpoint;
      const metadata = (row.metadata as CheckpointMetadata) ?? {};

      if (
        options?.filter &&
        !Object.entries(options.filter).every(
          ([k, v]) => (metadata as Record<string, unknown>)[k] === v,
        )
      ) {
        continue;
      }

      const writes = await this.prisma.graphCheckpointWrite.findMany({
        where: {
          threadId,
          checkpointNamespace: checkpointNs,
          checkpointId: row.checkpointId,
        },
        orderBy: [{ taskId: "asc" }, { idx: "asc" }],
      });
      const pendingWrites = await Promise.all(
        writes.map(async (w) => {
          const value = await this.serde.loadsTyped(
            w.type ?? "json",
            new Uint8Array(w.value),
          );
          return [w.taskId, w.channel, value] as [string, string, unknown];
        }),
      );

      const tuple: CheckpointTuple = {
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: row.checkpointId,
          },
        },
        checkpoint,
        metadata,
        pendingWrites,
      };
      if (row.parentCheckpointId) {
        tuple.parentConfig = {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: row.parentCheckpointId,
          },
        };
      }
      yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) {
      throw new Error(
        'PrismaCheckpointSaver.put: missing "thread_id" in configurable',
      );
    }
    const checkpointNs = (config.configurable?.checkpoint_ns as string) ?? "";
    const parentCheckpointId =
      (config.configurable?.checkpoint_id as string | undefined) ?? null;

    const prepared = copyCheckpoint(checkpoint);
    const [type, bytes] = await this.serde.dumpsTyped(prepared);

    await this.prisma.graphCheckpoint.upsert({
      where: {
        threadId_checkpointNamespace_checkpointId: {
          threadId,
          checkpointNamespace: checkpointNs,
          checkpointId: checkpoint.id,
        },
      },
      create: {
        threadId,
        checkpointNamespace: checkpointNs,
        checkpointId: checkpoint.id,
        parentCheckpointId,
        type,
        checkpoint: Buffer.from(bytes),
        metadata: (metadata ?? {}) as object,
      },
      update: {
        parentCheckpointId,
        type,
        checkpoint: Buffer.from(bytes),
        metadata: (metadata ?? {}) as object,
      },
    });

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const checkpointId = config.configurable?.checkpoint_id as
      | string
      | undefined;
    const checkpointNs = (config.configurable?.checkpoint_ns as string) ?? "";
    if (!threadId || !checkpointId) {
      throw new Error(
        'PrismaCheckpointSaver.putWrites: missing thread_id or checkpoint_id',
      );
    }

    for (let i = 0; i < writes.length; i++) {
      const [channel, value] = writes[i];
      const [type, bytes] = await this.serde.dumpsTyped(value);
      const idx = WRITES_IDX_MAP[channel] ?? i;
      await this.prisma.graphCheckpointWrite.upsert({
        where: {
          threadId_checkpointNamespace_checkpointId_taskId_idx: {
            threadId,
            checkpointNamespace: checkpointNs,
            checkpointId,
            taskId,
            idx,
          },
        },
        create: {
          threadId,
          checkpointNamespace: checkpointNs,
          checkpointId,
          taskId,
          idx,
          channel,
          type,
          value: Buffer.from(bytes),
        },
        update:
          idx >= 0
            ? {}
            : {
                channel,
                type,
                value: Buffer.from(bytes),
              },
      });
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.graphCheckpointWrite.deleteMany({ where: { threadId } }),
      this.prisma.graphCheckpoint.deleteMany({ where: { threadId } }),
    ]);
  }
}
