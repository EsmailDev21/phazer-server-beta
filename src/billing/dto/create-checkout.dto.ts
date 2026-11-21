import { IsEnum, IsUrl } from 'class-validator';
import { PlanKey } from '@prisma/client';

export class CreateCheckoutDto {
  @IsEnum(PlanKey)
  planKey: PlanKey;

  @IsUrl({ require_tld: false })
  successUrl: string;

  @IsUrl({ require_tld: false })
  cancelUrl: string;
}
