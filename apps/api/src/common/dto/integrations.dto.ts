import { IsString, IsObject, IsOptional } from "class-validator";

export class CreateIntegrationDto {
  @IsString()
  orgId!: string;

  @IsString()
  provider!: string;

  @IsObject()
  credentials!: Record<string, unknown>;
}

export class ConnectIntegrationDto {
  @IsString()
  orgId!: string;

  @IsString()
  provider!: string;
}
