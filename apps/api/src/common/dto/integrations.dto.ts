import { IsString, IsObject } from "class-validator";

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
