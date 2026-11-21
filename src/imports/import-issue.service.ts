import { Injectable } from '@nestjs/common';
import { ImportIssueSeverity, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IMPORT_LIMITS } from './imports.validation';

type Db = Prisma.TransactionClient | PrismaService;

export interface NewImportIssue {
  severity: ImportIssueSeverity;
  code: string;
  /** "<externalType>:<externalId>" or a human key. Omit for a job-level issue. */
  externalRef?: string | null;
  message: string;
}

const MESSAGE_MAX = 1000;
export const ISSUES_TRUNCATED = 'ISSUES_TRUNCATED';

/**
 * Step 4.1. Per-item problems an import skips past (diagram 05: "invalid -> ImportJobIssue, continue").
 * Bounded per job so a source with a million bad rows cannot fill the table: past the cap one
 * ISSUES_TRUNCATED row says so and the rest are dropped (the executor's counters still count them).
 */
@Injectable()
export class ImportIssueService {
  constructor(private readonly prisma: PrismaService) {}

  async record(importJobId: string, issues: readonly NewImportIssue[], db: Db = this.prisma): Promise<number> {
    if (issues.length === 0) return 0;
    const existing = await db.importJobIssue.count({ where: { importJobId } });
    const cap = IMPORT_LIMITS.maxIssuesPerJob;
    if (existing > cap) return 0; // the marker is already there

    const room = Math.max(cap - existing, 0);
    const kept = issues.slice(0, room);
    const rows: Prisma.ImportJobIssueCreateManyInput[] = kept.map((i) => ({
      importJobId,
      severity: i.severity,
      code: i.code.slice(0, 80),
      externalRef: i.externalRef ? i.externalRef.slice(0, 300) : null,
      message: i.message.slice(0, MESSAGE_MAX),
    }));
    if (issues.length > room) {
      rows.push({
        importJobId,
        severity: ImportIssueSeverity.WARN,
        code: ISSUES_TRUNCATED,
        message: `More than ${cap} issues; the rest were counted but not stored.`,
      });
    }
    await db.importJobIssue.createMany({ data: rows });
    return rows.length;
  }

  async page(
    importJobId: string,
    opts: { severity?: ImportIssueSeverity; afterId?: string; take: number },
  ) {
    return this.prisma.importJobIssue.findMany({
      where: {
        importJobId,
        ...(opts.severity ? { severity: opts.severity } : {}),
        ...(opts.afterId ? { id: { gt: opts.afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: opts.take,
    });
  }

  async countBySeverity(importJobId: string): Promise<Record<ImportIssueSeverity, number>> {
    const groups = await this.prisma.importJobIssue.groupBy({
      by: ['severity'],
      where: { importJobId },
      _count: { _all: true },
    });
    const out: Record<ImportIssueSeverity, number> = { INFO: 0, WARN: 0, ERROR: 0 };
    for (const g of groups) out[g.severity] = g._count._all;
    return out;
  }
}
