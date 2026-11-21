import { Global, Module } from '@nestjs/common';
import { AccessControlController } from './access-control.controller';
import { PermissionResolver } from './access-control.service';
import { AccessControlGuard } from './guards/access-control.guard';
import { PlanLimitsService } from './plan-limits.service';

/**
 * @Global — PermissionResolver and AccessControlGuard need to be usable
 * (via @RequireAccess) from any future domain module without each one
 * re-importing AccessControlModule explicitly. PlanLimitsService lives
 * here (not in a Billing module) since it's the real implementation of
 * this module's own step 8 — Billing only supplies the config numbers it
 * reads (see billing-tiers.config.ts), not the checking logic itself.
 */
@Global()
@Module({
  controllers: [AccessControlController],
  providers: [PermissionResolver, AccessControlGuard, PlanLimitsService],
  exports: [PermissionResolver, AccessControlGuard, PlanLimitsService],
})
export class AccessControlModule {}
