import { IsString, IsObject, Matches } from "class-validator";

export class CreateIntegrationDto {
  @IsString()
  provider!: string;

  @IsObject()
  credentials!: Record<string, unknown>;
}

export class ConnectIntegrationDto {
  @IsString()
  provider!: string;
}

export class FinalizeGmailOAuthDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/, {
    message: "attemptId must be a canonical opaque OAuth attempt id",
  })
  attemptId!: string;
}
