import { Global, Module } from "@nestjs/common";
import {
  PRODUCTION_BOOTSTRAP_WRITER_FENCE_REDIS,
  ProductionBootstrapWriterFenceService,
  productionBootstrapWriterFenceRedisProvider,
} from "./production-bootstrap-writer-fence";

@Global()
@Module({
  providers: [
    {
      provide: PRODUCTION_BOOTSTRAP_WRITER_FENCE_REDIS,
      useFactory: productionBootstrapWriterFenceRedisProvider,
    },
    ProductionBootstrapWriterFenceService,
  ],
  exports: [ProductionBootstrapWriterFenceService],
})
export class ProductionBootstrapOpsModule {}
