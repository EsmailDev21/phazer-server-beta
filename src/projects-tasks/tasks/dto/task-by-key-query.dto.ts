import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class TaskByKeyQueryDto {
  /**
   * REQUIRED (ADR-0004 decision 5): a key like ENG-123 is only unique within an
   * account, and a user can belong to several. Integrations pass the account
   * of their connection.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  accountId: string;
}
