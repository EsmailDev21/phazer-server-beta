import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';

export class ApplyTemplateDto {
  /** The workspace to apply INTO (create it first for a "new workspace": see action-config.ts). */
  @IsString()
  workspaceId: string;

  /** NEW_WORKSPACE asserts the workspace is empty; MERGE (default) adds to whatever is there. */
  @IsOptional() @IsIn(['NEW_WORKSPACE', 'MERGE'])
  mode?: 'NEW_WORKSPACE' | 'MERGE';

  /** A version `sequence`; default the latest. */
  @IsOptional() @IsInt() @Min(1)
  version?: number;

  /** { variableKey: value } - see the blueprint's `variables`. */
  @IsOptional() @IsObject()
  variables?: Record<string, unknown>;

  /** { moduleKey: boolean } */
  @IsOptional() @IsObject()
  modules?: Record<string, unknown>;

  /** { roleKey: { type: 'MEMBER', userId } | { type: 'INVITE', email } | { type: 'UNASSIGNED' } } */
  @IsOptional() @IsObject()
  roles?: Record<string, unknown>;
}

export class UndoInstallDto {
  /** Also delete what was EDITED since the apply. Things in use by other work are never deleted. */
  @IsOptional() @IsBoolean()
  confirmEdited?: boolean;
}
