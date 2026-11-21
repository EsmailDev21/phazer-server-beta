import { ActivityAction, ActivityVisibility, TaskStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDefined, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

export class ConnectIntegrationDto {
  @IsString()
  @IsNotEmpty()
  accountId: string;
}

export class ListConnectionsQueryDto {
  @IsString()
  @IsNotEmpty()
  accountId: string;
}

/** The ONLY shape of a connection that leaves the API. No credential, no kid, no ciphertext. */
export interface IntegrationConnectionDto {
  id: string;
  provider: string;
  externalAccountId: string;
  externalAccountName: string;
  scopes: string[];
  status: string;
  lastError: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export class StartIdentityLinkDto {
  @IsString()
  @IsNotEmpty()
  connectionId: string;
}

export class ManualIdentityLinkDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  externalUserId: string;

  @IsString()
  @IsNotEmpty()
  userId: string;
}

export class LinkTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token: string;
}

/** Identity link as it leaves the API. */
export interface IdentityLinkDto {
  id: string;
  connectionId: string;
  externalUserId: string;
  externalEmail: string | null;
  userId: string | null;
  method: string;
  createdAt: Date;
}

// ---- step 2.3 (ADR-0011)
export class CreateChannelLinkDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  externalId: string;

  @IsString() @IsNotEmpty()
  workspaceId: string;

  /** Omitted = the whole workspace. */
  @IsOptional() @IsString() @IsNotEmpty()
  projectId?: string;
}

export class CreateSubscriptionDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @IsEnum(ActivityAction, { each: true })
  events?: ActivityAction[];

  @IsOptional() @IsEnum(ActivityVisibility)
  minVisibility?: ActivityVisibility;
}

export class UpdateSubscriptionDto extends CreateSubscriptionDto {
  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

export interface SubscriptionDto {
  id: string;
  channelLinkId: string;
  events: ActivityAction[];
  minVisibility: ActivityVisibility;
  enabled: boolean;
  failureCount: number;
  disabledReason: string | null;
}

export interface ChannelLinkDto {
  id: string;
  connectionId: string;
  kind: string;
  externalId: string;
  workspaceId: string;
  projectId: string | null;
  pausedAt: Date | null;
  /** Provider settings (step 2.6: GitHub REPO links keep `{repoFullName, statusRules}` here). Null for chat links. */
  config: unknown;
  createdAt: Date;
  subscriptions: SubscriptionDto[];
}

export interface ChannelDeliveryDto {
  id: string;
  activityId: string;
  status: string;
  attempts: number;
  error: string | null;
  createdAt: Date;
}

// ---- step 2.6 (ADR-0014): GitHub repo <-> project links and their status rules
/** `null` clears a rule; omitted leaves it as it is. Values are workflow CATEGORIES. */
export class StatusRulesDto {
  @IsOptional() @IsEnum(TaskStatus)
  prOpened?: TaskStatus | null;

  @IsOptional() @IsEnum(TaskStatus)
  prMerged?: TaskStatus | null;

  @IsOptional() @IsEnum(TaskStatus)
  prClosed?: TaskStatus | null;
}

export class LinkRepoDto {
  /** GitHub's numeric repository id (from the repository list), not the name: names change, ids do not. */
  @IsInt() @Min(1)
  repoId: number;

  @IsString() @IsNotEmpty()
  projectId: string;

  /** Omitted = the defaults (opened -> In progress, merged -> Done, closed unmerged -> no change). */
  @IsOptional() @ValidateNested() @Type(() => StatusRulesDto)
  statusRules?: StatusRulesDto;
}

export class UpdateStatusRulesDto {
  @IsDefined() @ValidateNested() @Type(() => StatusRulesDto)
  statusRules: StatusRulesDto;
}

export interface GithubRepositoryDto {
  id: number;
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  /** The REPO link that already exists for it in this connection, if any. */
  linkId: string | null;
}
