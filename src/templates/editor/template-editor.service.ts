import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BlueprintV1 } from '../blueprint';
import { diffBlueprints } from '../diff';
import { TemplatesService, VersionSummaryDto } from '../templates.service';
import { applyOps } from './editor.apply';

export interface DraftDto {
  templateId: string;
  baseSequence: number;
  revision: number;
  blueprint: unknown;
  createdAt: Date;
  updatedAt: Date;
  updatedById: string;
}

const noDraft = () => new NotFoundException({ code: 'NO_DRAFT', message: 'This template has no draft' });
const lockVersions = (tx: Prisma.TransactionClient, templateId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`template-versions:${templateId}`}, 0))`;

/**
 * Step 3.8. The template editor: one mutable, always-valid draft per template, changed by
 * operations (see editor.types.ts) and published as the next version.
 *
 * Concurrency: every write quotes the draft's `revision`; the draft row is locked FOR UPDATE for the
 * whole request, so of two writers with the same revision exactly one wins and the other gets a 409.
 * Lock order is always  version lock -> draft row -> template row  (the first only for publish).
 */
@Injectable()
export class TemplateEditorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
  ) {}

  /** Starts editing from the LATEST version. One draft per template. */
  async createDraft(templateId: string, userId: string): Promise<DraftDto> {
    const latest = await this.prisma.templateVersion.findFirst({
      where: { templateId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true, checksum: true, blueprint: true },
    });
    if (!latest) throw new NotFoundException('Template not found');
    try {
      const d = await this.prisma.templateDraft.create({
        data: { templateId, baseSequence: latest.sequence, baseChecksum: latest.checksum, blueprint: latest.blueprint as Prisma.InputJsonValue, createdById: userId, updatedById: userId },
      });
      return this.dto(d);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        const cur = await this.prisma.templateDraft.findUnique({ where: { templateId }, select: { revision: true, baseSequence: true } });
        throw new ConflictException({ code: 'DRAFT_EXISTS', message: 'This template already has a draft', revision: cur?.revision, baseSequence: cur?.baseSequence });
      }
      throw err;
    }
  }

  async getDraft(templateId: string): Promise<DraftDto> {
    const d = await this.prisma.templateDraft.findUnique({ where: { templateId } });
    if (!d) throw noDraft();
    return this.dto(d);
  }

  /** Applies a batch of operations atomically. Nothing is saved unless the whole result validates. */
  async patchDraft(templateId: string, userId: string, input: { ifRevision: number; ops: unknown[] }) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ revision: number; blueprint: unknown }>>`SELECT revision, blueprint FROM template_drafts WHERE template_id = ${templateId} FOR UPDATE`;
      const draft = rows[0];
      if (!draft) throw noDraft();
      this.assertRevision(draft.revision, input.ifRevision);

      const seqRows = await tx.$queryRaw<Array<{ node_key_seq: number }>>`SELECT node_key_seq FROM templates WHERE id = ${templateId} FOR UPDATE`;
      const catalog = await tx.templateAsset.findMany({ where: { templateId }, select: { sha256: true, fileName: true, mimeType: true, sizeBytes: true } });
      const r = applyOps(draft.blueprint, input.ops, seqRows[0]?.node_key_seq ?? 0, catalog);
      if (r.ok === false) {
        throw new UnprocessableEntityException(
          r.kind === 'op'
            ? { code: 'OP_FAILED', message: r.error.message, error: r.error }
            : { code: 'BLUEPRINT_INVALID', message: 'These changes would make the template invalid', issues: r.issues, truncated: r.truncated },
        );
      }
      const updated = await tx.templateDraft.update({
        where: { templateId },
        data: { blueprint: r.blueprint as Prisma.InputJsonValue, revision: { increment: 1 }, updatedById: userId, updatedAt: new Date() },
        select: { revision: true },
      });
      await tx.$executeRaw`UPDATE templates SET node_key_seq = GREATEST(node_key_seq, ${r.nextSeq}) WHERE id = ${templateId}`;
      return { revision: updated.revision, created: r.created, minted: r.minted, cascaded: r.cascaded };
    });
  }

  /** What the draft changes compared with the version it started from. */
  async diffDraft(templateId: string) {
    const d = await this.prisma.templateDraft.findUnique({ where: { templateId }, select: { baseSequence: true, revision: true, blueprint: true } });
    if (!d) throw noDraft();
    const base = await this.prisma.templateVersion.findUniqueOrThrow({ where: { templateId_sequence: { templateId, sequence: d.baseSequence } }, select: { blueprint: true } });
    return { baseSequence: d.baseSequence, revision: d.revision, ...diffBlueprints(base.blueprint as unknown as BlueprintV1, d.blueprint as unknown as BlueprintV1) };
  }

  /** Turns the draft into the next version and removes it - in one transaction. */
  async publishDraft(templateId: string, userId: string, input: { ifRevision: number; bump?: 'major' | 'minor' | 'patch'; changelog?: string }): Promise<VersionSummaryDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockVersions(tx, templateId);
      const rows = await tx.$queryRaw<Array<{ revision: number; blueprint: unknown; base_sequence: number }>>`SELECT revision, blueprint, base_sequence FROM template_drafts WHERE template_id = ${templateId} FOR UPDATE`;
      const draft = rows[0];
      if (!draft) throw noDraft();
      this.assertRevision(draft.revision, input.ifRevision);

      const latest = await tx.templateVersion.findFirst({ where: { templateId }, orderBy: { sequence: 'desc' }, select: { sequence: true, blueprint: true } });
      if (!latest || latest.sequence !== draft.base_sequence) {
        throw new ConflictException({
          code: 'DRAFT_STALE',
          message: 'A newer version was published after this draft was started. Discard the draft and start again from the latest version.',
          baseSequence: draft.base_sequence,
          latestSequence: latest?.sequence,
        });
      }
      const { bp, version } = this.templates.validated(draft.blueprint);
      const changelog = input.changelog ?? this.autoChangelog(diffBlueprints(latest.blueprint as unknown as BlueprintV1, bp).summary);
      const created = await this.templates.addVersionInTx(tx, templateId, userId, bp, version, { bump: input.bump, changelog });
      await tx.templateDraft.delete({ where: { templateId } });
      return created;
    });
  }

  async discardDraft(templateId: string, ifRevision?: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ revision: number }>>`SELECT revision FROM template_drafts WHERE template_id = ${templateId} FOR UPDATE`;
      if (!rows[0]) throw noDraft();
      if (ifRevision !== undefined) this.assertRevision(rows[0].revision, ifRevision);
      await tx.templateDraft.delete({ where: { templateId } });
    });
  }

  // ------------------------------------------------------------------ helpers -------------
  private assertRevision(current: number, quoted: number) {
    if (current !== quoted) {
      throw new ConflictException({ code: 'DRAFT_REVISION_CONFLICT', message: 'The draft changed since you loaded it', currentRevision: current });
    }
  }

  private autoChangelog(s: { added: number; removed: number; modified: number; moved: number; reordered: number }): string {
    const parts = (['added', 'removed', 'modified', 'moved', 'reordered'] as const).filter((k) => s[k] > 0).map((k) => `${s[k]} ${k}`);
    return `Edited in the template editor${parts.length ? ': ' + parts.join(', ') : ''}`;
  }

  private dto(d: { templateId: string; baseSequence: number; revision: number; blueprint: unknown; createdAt: Date; updatedAt: Date; updatedById: string }): DraftDto {
    return { templateId: d.templateId, baseSequence: d.baseSequence, revision: d.revision, blueprint: d.blueprint, createdAt: d.createdAt, updatedAt: d.updatedAt, updatedById: d.updatedById };
  }
}
