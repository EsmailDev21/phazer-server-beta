import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ActivityService } from './activity.service';
import { AuditLogService } from './audit-log.service';

/**
 * @Global, imported ONCE from AppModule. EventEmitterModule.forRoot()
 * must only be called once app-wide (duplicate calls create separate
 * event-bus instances, silently breaking @OnEvent listeners registered
 * against a different instance) — this is the one place it happens.
 *
 * Pulled out of ActivityNotificationsModule specifically to avoid a
 * circular dependency: TasksService/ProjectsService (Projects/Tasks
 * module) and AccountsService/TeamsService/InvitesService (Tenancy
 * module) all need to call ActivityService/AuditLogService to emit
 * events, while ActivityNotificationsModule itself needs
 * TaskVisibilityService FROM the Projects/Tasks module (for
 * ActivitiesService's visibility gating) — a two-way dependency if
 * Activity/AuditLog writing lived inside ActivityNotificationsModule.
 * Being @Global sidesteps it entirely: any module can inject
 * ActivityService/AuditLogService/EventEmitter2 without listing this
 * module in its own `imports`, as long as EventsModule is imported
 * somewhere reachable from the root (AppModule).
 */
@Global()
@Module({
  imports: [EventEmitterModule.forRoot()],
  providers: [ActivityService, AuditLogService],
  exports: [ActivityService, AuditLogService],
})
export class EventsModule {}
