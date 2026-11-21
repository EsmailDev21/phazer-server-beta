import { IsEnum, IsString } from 'class-validator';
import {
  ALL_TARGET_TYPES,
  TargetType,
} from '../interfaces/access-control.types';
import { ACTION_CONFIG } from '../config/action-config';

/**
 * BUG FIX: this previously hand-maintained a parallel copy of every valid
 * action/targetType, which silently drifted out of sync as new actions
 * (editTeam, deleteTeam, manageTeamMembers, reactToTarget) and target
 * types (TEAM, ACTIVITY) were added later in the build — those all work
 * everywhere else via @RequireAccess, but this endpoint's DTO rejected
 * them with a 400. Derived directly from the real config objects now, so
 * this can't drift again.
 */
const ACTION_NAMES = Object.keys(
  ACTION_CONFIG,
) as (keyof typeof ACTION_CONFIG)[];

export class CheckAccessDto {
  @IsEnum(ACTION_NAMES)
  action: (typeof ACTION_NAMES)[number];

  @IsEnum(ALL_TARGET_TYPES)
  targetType: TargetType;

  @IsString()
  targetId: string;
}
