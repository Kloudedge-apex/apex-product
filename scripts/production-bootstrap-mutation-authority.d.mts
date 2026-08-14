export interface ProductionBootstrapMutationAuthorityOptions {
  readonly attemptId: string;
  readonly expectedBackendCommit: string;
  readonly subscriptionId: string;
  readonly storageAccount: string;
  readonly storageContainer: string;
  readonly storageBlob: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export function verifyProductionBootstrapMutationAuthority(
  options: ProductionBootstrapMutationAuthorityOptions,
): true;
