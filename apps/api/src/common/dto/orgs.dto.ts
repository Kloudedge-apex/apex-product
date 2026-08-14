import {
  IsString,
  IsOptional,
  MinLength,
  MaxLength,
  Matches,
  IsISO31661Alpha2,
} from "class-validator";
import { Transform } from "class-transformer";

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
  @MaxLength(255)
  website?: string;

  // Sender identity — CAN-SPAM §7704(a)(5). The send worker fail-closes live
  // email outreach while physicalAddress is null, and the global
  // ValidationPipe runs with `whitelist: true`, so these MUST be declared
  // here or the pipe silently strips them from the body (which is exactly
  // how the field became unsettable). Trimmed before the length checks so a
  // padded-whitespace address cannot sneak past the 5-char floor.
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @MinLength(5)
  @MaxLength(500)
  physicalAddress?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @MinLength(1)
  @MaxLength(120)
  senderName?: string;

  // Uppercase ISO-3166 alpha-2 only. validator's isISO31661Alpha2 uppercases
  // its input before checking, so the @Matches is what actually rejects "us";
  // @IsISO31661Alpha2 then rejects unassigned codes like "ZZ".
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: "country must be a 2-letter uppercase ISO-3166 alpha-2 code",
  })
  @IsISO31661Alpha2()
  country?: string;
}
