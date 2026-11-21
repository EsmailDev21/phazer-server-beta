import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { OAuthStateSweepJob } from './core/oauth-state-sweep.job';
import { ChannelDeliverySweepJob } from './notify/channel-delivery-sweep.job';

/** Imported by BOTH the API and the worker graph (like IntegrationWebhooksModule): the worker runs the sweep. */
@Module({ imports: [DiscoveryModule], providers: [OAuthStateSweepJob, ChannelDeliverySweepJob] })
export class IntegrationMaintenanceModule {}
