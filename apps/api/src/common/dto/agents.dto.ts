import {
  IsString,
  IsOptional,
  IsIn,
  IsObject,
  MinLength,
  MaxLength,
} from "class-validator";

export class CreateAgentDto {
  @IsString()
  templateId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsIn(["SALES", "MARKETING", "OPS"])
  domain!: "SALES" | "MARKETING" | "OPS";

  @IsObject()
  config!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  schedule?: string;
}

export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  schedule?: string;
}

export class CreateFromTemplateDto {
  @IsString()
  @MinLength(1)
  templateSlug!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsObject()
  configOverrides?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  schedule?: string;
}

export class SetMemoryDto {
  @IsString()
  @MinLength(1)
  key!: string;

  value!: unknown;
}
