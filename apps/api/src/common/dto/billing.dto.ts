import { IsString } from "class-validator";

export class CreateSubscriptionDto {
  @IsString()
  planId!: string;
}
