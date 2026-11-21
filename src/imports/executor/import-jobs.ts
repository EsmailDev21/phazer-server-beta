import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../../queue/job-handler.registry';
import { JobPayloads, QUEUES } from '../../queue/queue.definitions';
import { ImportExecutor } from './import-executor.service';
import { ImportRollback } from './import-rollback.service';

/** Step 4.4. The two queue handlers (worker process). Thin: all rules live in the executor / rollback services. */
@Injectable()
export class ImportRunJob implements JobHandler<'imports.run'>, OnModuleInit {
  private readonly logger = new Logger(ImportRunJob.name);
  readonly queue = QUEUES.IMPORTS.name;
  readonly jobName = 'imports.run' as const;
  constructor(private readonly registry: JobHandlerRegistry, private readonly executor: ImportExecutor) {}
  onModuleInit(): void {
    this.registry.register(this);
  }
  async handle(envelope: JobEnvelope) {
    const payload = envelope.payload as JobPayloads['imports.run'];
    const r = await this.executor.run(payload);
    if (r === 'STALE') this.logger.log(`imports.run ${payload.importJobId}#${payload.attempt}: stale or not runnable, ignored`);
    return r;
  }
}

@Injectable()
export class ImportRollbackJob implements JobHandler<'imports.rollback'>, OnModuleInit {
  private readonly logger = new Logger(ImportRollbackJob.name);
  readonly queue = QUEUES.IMPORTS.name;
  readonly jobName = 'imports.rollback' as const;
  constructor(private readonly registry: JobHandlerRegistry, private readonly rollback: ImportRollback) {}
  onModuleInit(): void {
    this.registry.register(this);
  }
  async handle(envelope: JobEnvelope) {
    const payload = envelope.payload as JobPayloads['imports.rollback'];
    const r = await this.rollback.run(payload);
    if (r === 'STALE') this.logger.log(`imports.rollback ${payload.importJobId}: not rolling back, ignored`);
    return r;
  }
}

/** Step 4.6. The attachment-copy phase of an import, on its own queue (`import-files`) so a slow download never holds a task-chunk slot. */
@Injectable()
export class ImportCopyFilesJob implements JobHandler<'imports.copy-files'>, OnModuleInit {
  private readonly logger = new Logger(ImportCopyFilesJob.name);
  readonly queue = QUEUES.IMPORT_FILES.name;
  readonly jobName = 'imports.copy-files' as const;
  constructor(private readonly registry: JobHandlerRegistry, private readonly executor: ImportExecutor) {}
  onModuleInit(): void {
    this.registry.register(this);
  }
  async handle(envelope: JobEnvelope) {
    const payload = envelope.payload as JobPayloads['imports.copy-files'];
    const r = await this.executor.runFiles(payload);
    if (r === 'STALE') this.logger.log(`imports.copy-files ${payload.importJobId}#${payload.attempt}: stale or not running, ignored`);
    return r;
  }
}
