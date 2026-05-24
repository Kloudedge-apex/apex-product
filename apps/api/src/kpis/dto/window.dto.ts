import { IsInt, Max, Min } from "class-validator";

export class WindowDto {
  @IsInt()
  @Min(1)
  @Max(90)
  windowDays: number = 7;
}

