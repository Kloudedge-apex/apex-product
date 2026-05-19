import { IsString, IsOptional, MinLength, MaxLength } from "class-validator";

// clerkUserId and email are NOT in this DTO on purpose — they come from the
// verified Clerk JWT (req.headers.authorization), never the request body.
// Accepting them from the body would let a caller spoof another user's identity.
export class CreateOrgDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  slug?: string;

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
