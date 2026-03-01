import { IsString, IsOptional, IsEmail, MinLength, MaxLength } from "class-validator";

export class CreateOrgDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsString()
  clerkUserId!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  userName?: string;
}

export class UpdateOrgDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  plan?: string;
}
