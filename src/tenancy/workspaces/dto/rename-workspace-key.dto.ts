import { IsString, MaxLength } from 'class-validator';

export class RenameWorkspaceKeyDto {
  // Format ^[A-Z][A-Z0-9]{1,9}$ (case-insensitive input) is enforced by the service.
  @IsString()
  @MaxLength(32)
  key: string;
}
