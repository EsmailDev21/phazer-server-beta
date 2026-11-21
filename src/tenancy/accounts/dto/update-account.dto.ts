import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * WHITELIST-ONLY: name/logo, nothing else. Deliberately does NOT declare
 * planType, paymentProvider, externalCustomerId, externalSubscriptionId,
 * billingCountry, seatsIncluded/Used, or any other billing-internal field
 * — those are managed exclusively by the Billing module (checkout,
 * webhooks), never user-editable here. Same discipline as Foundations
 * Rule 1 applied to what this DTO does NOT include, not just what it
 * validates. The global ValidationPipe's forbidNonWhitelisted rejects any
 * request that tries to sneak those fields in anyway.
 */
export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  logo?: string;
}
