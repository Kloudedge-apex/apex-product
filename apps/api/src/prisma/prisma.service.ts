import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import {
  isClearlyReadOnlyPrismaRawQuery,
  isPrismaWriteOperation,
  ProductionBootstrapWriterFenceService,
  runDatabaseWriteWithProductionBootstrapWriterFence,
  runInteractiveTransactionWithProductionBootstrapWriterFence,
} from "../ops/production-bootstrap-writer-fence";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    @Optional()
    private readonly productionBootstrapWriterFence?: ProductionBootstrapWriterFenceService,
  ) {
    super();
    const fence = this.productionBootstrapWriterFence;
    const extended = this.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!isPrismaWriteOperation(operation)) return query(args);
            return runDatabaseWriteWithProductionBootstrapWriterFence(
              fence,
              model,
              operation,
              () => query(args),
            );
          },
        },
        async $executeRaw({ args, query }) {
          return runDatabaseWriteWithProductionBootstrapWriterFence(
            fence,
            undefined,
            "$executeRaw",
            () => query(args),
          );
        },
        async $executeRawUnsafe({ args, query }) {
          return runDatabaseWriteWithProductionBootstrapWriterFence(
            fence,
            undefined,
            "$executeRawUnsafe",
            () => query(args),
          );
        },
        async $queryRaw({ args, query }) {
          if (isClearlyReadOnlyPrismaRawQuery(args)) return query(args);
          return runDatabaseWriteWithProductionBootstrapWriterFence(
            fence,
            undefined,
            "$queryRaw",
            () => query(args),
          );
        },
        async $queryRawUnsafe({ args, query }) {
          return runDatabaseWriteWithProductionBootstrapWriterFence(
            fence,
            undefined,
            "$queryRawUnsafe",
            () => query(args),
          );
        },
      },
    });

    // Query extensions propagate to transaction clients. Additionally fence
    // interactive transactions before Prisma opens a database transaction so
    // a closed bootstrap cannot be bypassed before the callback is entered.
    // Batch transactions remain readable; each model/raw mutation in the
    // array is independently intercepted by the query extension above.
    const invokeTransaction = extended.$transaction.bind(extended) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    Object.defineProperty(extended, "$transaction", {
      configurable: true,
      value: (first: unknown, ...rest: unknown[]) => {
        const invoke = () => invokeTransaction(first, ...rest);
        return typeof first === "function"
          ? runInteractiveTransactionWithProductionBootstrapWriterFence(
              fence,
              invoke,
            )
          : invoke();
      },
    });

    return extended as this;
  }

  async onModuleInit() {
    await this.$connect();
    console.log("[Prisma] Connected to database");
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
