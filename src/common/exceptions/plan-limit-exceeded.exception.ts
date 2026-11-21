import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 402 Payment Required — deliberately distinct from 403 Forbidden. A 403
 * means "you don't have permission"; this means "you have permission,
 * but your plan's quota is exhausted" — a different, actionable-by-
 * upgrading condition the frontend should render differently (e.g. an
 * upgrade prompt, not an access-denied message). Extends HttpException
 * so AllExceptionsFilter handles it automatically like everything else.
 */
export class PlanLimitExceededException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.PAYMENT_REQUIRED);
  }
}
