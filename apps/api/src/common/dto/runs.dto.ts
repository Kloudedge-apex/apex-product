import { IsString, IsOptional, IsInt, Min, Max } from "class-validator";
import { Type } from "class-transformer";

export class ListRunsQueryDto {
  @IsString()
  orgId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  agentId?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  search?: string;
}

export class CreateRunDto {
  @IsString()
  agentId!: string;

  @IsString()
  orgId!: string;
}
