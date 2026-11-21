import { Logger, Module } from '@nestjs/common';
import { ConnectionLifecycleService } from './core/connection-lifecycle.service';
import { ConnectorRegistry } from './core/connector.registry';
import { CredentialService } from './core/credential.service';
import { INTEGRATION_ADAPTERS, PROVIDER_FETCH, PROVIDER_HTTP_OPTIONS } from './core/integration.types';
import { ProviderHttpClient, resolveProviderHttpTuning } from './core/provider-http.client';
import { RedisLockService } from './core/redis-lock.service';
import { DiscordAdapter } from './providers/discord.adapter';
import { GithubAdapter } from './providers/github.adapter';
import { SlackAdapter } from './providers/slack.adapter';
import { AsanaAdapter } from './providers/asana/asana.adapter';
import { AsanaClient } from './providers/asana/asana.client';
import { NotionAdapter } from './providers/notion/notion.adapter';
import { NotionClient } from './providers/notion/notion.client';
import { MondayAdapter } from './providers/monday/monday.adapter';
import { MondayClient } from './providers/monday/monday.client';
import { ClickUpAdapter } from './providers/clickup/clickup.adapter';
import { ClickUpClient } from './providers/clickup/clickup.client';
import { JiraAdapter } from './providers/jira/jira.adapter';
import { JiraClient } from './providers/jira/jira.client';
import { LinearAdapter } from './providers/linear/linear.adapter';
import { LinearClient } from './providers/linear/linear.client';

/**
 * Provider plumbing shared by BOTH processes: the API (connect, identify) and the worker (notify.deliver, and later
 * webhook processing) need the same registry, HTTP client and credential refresh. A new provider = one adapter class
 * + one line in the factory below + the enum value. Prisma, Redis, Crypto, AccessControl and Events are @Global.
 */
@Module({
  providers: [
    // Lazy lookup so a test (or a future proxy) can replace the global fetch.
    { provide: PROVIDER_FETCH, useValue: (...a: Parameters<typeof fetch>) => fetch(...a) },
    {
      provide: PROVIDER_HTTP_OPTIONS,
      useFactory: () => {
        const { tuning, problems } = resolveProviderHttpTuning(process.env);
        for (const p of problems) new Logger('ProviderHttpTuning').warn(p);
        return tuning;
      },
    },
    ProviderHttpClient,
    RedisLockService,
    DiscordAdapter,
    SlackAdapter,
    GithubAdapter,
    // step 4.5 / 4.7 / 4.8 / 4.10-4.12: the importers (read-only providers)
    LinearClient,
    LinearAdapter,
    ClickUpClient,
    ClickUpAdapter,
    JiraClient,
    JiraAdapter,
    AsanaClient,
    AsanaAdapter,
    MondayClient,
    MondayAdapter,
    NotionClient,
    NotionAdapter,
    {
      provide: INTEGRATION_ADAPTERS,
      useFactory: (d: DiscordAdapter, s: SlackAdapter, g: GithubAdapter, l: LinearAdapter, k: ClickUpAdapter, j: JiraAdapter, a: AsanaAdapter, m: MondayAdapter, n: NotionAdapter) => [d, s, g, l, k, j, a, m, n],
      inject: [DiscordAdapter, SlackAdapter, GithubAdapter, LinearAdapter, ClickUpAdapter, JiraAdapter, AsanaAdapter, MondayAdapter, NotionAdapter],
    },
    ConnectorRegistry,
    CredentialService,
    ConnectionLifecycleService,
  ],
  exports: [ProviderHttpClient, RedisLockService, ConnectorRegistry, CredentialService, ConnectionLifecycleService],
})
export class IntegrationCoreModule {}
