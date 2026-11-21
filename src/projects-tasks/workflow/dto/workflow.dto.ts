import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { TaskStatus } from '@prisma/client';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export class CreateWorkflowStatusDto {
  @IsString()
  name: string;

  @IsEnum(TaskStatus)
  category: TaskStatus;

  @IsOptional()
  @Matches(HEX_COLOR, { message: 'color must be a #RRGGBB hex colour' })
  color?: string;

  /** 0-based index to insert at; omitted = append. Positions are renumbered. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  position?: number;

  @IsOptional()
  @IsBoolean()
  excludeFromProgress?: boolean;

  /** true = make it the default of its category (the one `PATCH {status}` lands on). */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateWorkflowStatusDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(TaskStatus)
  category?: TaskStatus;

  @IsOptional()
  @Matches(HEX_COLOR, { message: 'color must be a #RRGGBB hex colour' })
  color?: string;

  @IsOptional()
  @IsBoolean()
  excludeFromProgress?: boolean;

  /** Only `true` is accepted: make ANOTHER status the default to take the flag away. */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class DeleteWorkflowStatusQueryDto {
  /** Mandatory when any task (archived included) uses the status. */
  @IsOptional()
  @IsString()
  reassignTo?: string;
}

export class ReorderWorkflowDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  statusIds: string[];
}

export class TransitionDto {
  @IsString()
  fromStatusId: string;

  @IsString()
  toStatusId: string;
}

export class SetTransitionsDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => TransitionDto)
  transitions: TransitionDto[];
}

export class UpdateWorkflowSettingsDto {
  @IsOptional()
  @IsBoolean()
  enforceTransitions?: boolean;

  /** The status new tasks start in; must be in the To Do category. */
  @IsOptional()
  @IsString()
  defaultStatusId?: string;
}
