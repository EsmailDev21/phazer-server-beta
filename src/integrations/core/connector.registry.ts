import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IntegrationProvider } from '@prisma/client';
import { ConnectorAdapter, INTEGRATION_ADAPTERS } from './integration.types';

/** provider -> adapter (Nest multi-provider). Adding a provider = one adapter file + one entry in the module. */
@Injectable()
export class ConnectorRegistry {
  private readonly byProvider = new Map<IntegrationProvider, ConnectorAdapter>();

  constructor(@Inject(INTEGRATION_ADAPTERS) adapters: ConnectorAdapter[]) {
    for (const a of adapters) {
      if (this.byProvider.has(a.provider)) {
        throw new Error(`Two adapters registered for ${a.provider}`);
      }
      this.byProvider.set(a.provider, a);
    }
  }

  /** Throws 404 for a provider with no adapter (e.g. JIRA before Phase 4). */
  get(provider: IntegrationProvider): ConnectorAdapter {
    const a = this.byProvider.get(provider);
    if (!a) throw new NotFoundException('Unknown integration provider');
    return a;
  }

  has(provider: IntegrationProvider): boolean {
    return this.byProvider.has(provider);
  }

  all(): ConnectorAdapter[] {
    return [...this.byProvider.values()];
  }
}

/** URL segment -> enum. 'discord' and 'DISCORD' both work; anything else is a 404. */
export function parseProviderParam(raw: string): IntegrationProvider {
  const upper = (raw ?? '').toUpperCase();
  if ((Object.values(IntegrationProvider) as string[]).includes(upper)) {
    return upper as IntegrationProvider;
  }
  throw new NotFoundException('Unknown integration provider');
}
