import { IsString } from "class-validator";

export class TriggerRunBodyDto {
  @IsString()
  orgId!: string;
}
