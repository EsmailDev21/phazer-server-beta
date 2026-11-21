import { IsUrl } from 'class-validator';

export class PortalUrlDto {
  @IsUrl({ require_tld: false })
  returnUrl: string;
}
