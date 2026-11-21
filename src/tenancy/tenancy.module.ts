import { Module } from '@nestjs/common';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';
import { AccountPurgeJob } from './accounts/account-purge.job';
import { WorkspacesController } from './workspaces/workspaces.controller';
import { WorkspacesService } from './workspaces/workspaces.service';
import { WorkspaceKeysService } from './workspaces/workspace-keys.service';
import { TeamsController } from './teams/teams.controller';
import { TeamsService } from './teams/teams.service';
import { InvitesController } from './invites/invites.controller';
import { InvitesService } from './invites/invites.service';
import { BillingModule } from '../billing/billing.module';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  // BillingModule/AttachmentsModule: only AccountPurgeJob (step 0.3) needs
  // them, so that a normal request-path change to Tenancy's CRUD doesn't
  // have to reason about Billing or Attachments at all. Confirmed neither
  // module imports anything back into Tenancy or Projects/Tasks — no cycle.
  imports: [BillingModule, AttachmentsModule],
  controllers: [
    AccountsController,
    WorkspacesController,
    TeamsController,
    InvitesController,
  ],
  providers: [
    AccountsService,
    AccountPurgeJob,
    WorkspacesService,
    WorkspaceKeysService,
    TeamsService,
    InvitesService,
  ],
  // AccountsService: added for account-purge.job.ts (step 0.3) — the
  // worker needs it to enumerate/hard-delete expired soft-deletes.
  exports: [AccountsService, WorkspacesService, WorkspaceKeysService],
})
export class TenancyModule {}
