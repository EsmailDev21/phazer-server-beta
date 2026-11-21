import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { newEntityId } from '../domain-writer/entity-id';
import { PrismaService } from '../prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

export interface NewExternalRef {
  externalType: string;
  externalId: string;
  externalKey?: string | null;
  localType: string;
  localId: string;
  contentHash?: string | null;
}

export interface ExternalRefRow {
  externalType: string;
  externalId: string;
  localType: string;
  localId: string;
  contentHash: string | null;
  importJobId: string;
  /** true = this call created the ref; false = it already existed (a re-run). */
  inserted: boolean;
}

/**
 * Step 4.1. ExternalRef is how a re-run finds what it already made (diagram 05): unique on
 * (connection, externalType, externalId). The executor (4.4) looks refs up before writing a chunk, writes the
 * missing rows, then upserts the refs INSIDE the same transaction (pass its `tx`) so a crash can never leave a
 * row without its ref, or a ref without its row.
 */
@Injectable()
export class ExternalRefService {
  constructor(private readonly prisma: PrismaService) {}

  /** externalId -> row, for the ids that already have a ref. */
  async lookup(
    connectionId: string,
    externalType: string,
    externalIds: readonly string[],
    db: Db = this.prisma,
  ) {
    const out = new Map<
      string,
      { localId: string; localType: string; contentHash: string | null; importJobId: string }
    >();
    if (externalIds.length === 0) return out;
    const rows = await db.externalRef.findMany({
      where: { connectionId, externalType, externalId: { in: [...externalIds] } },
      select: { externalId: true, localId: true, localType: true, contentHash: true, importJobId: true },
    });
    for (const r of rows) out.set(r.externalId, r);
    return out;
  }

  /**
   * One round trip for a whole chunk. On conflict the existing ref KEEPS its importJobId and localId (the job that
   * created the row owns it - rolling back a later re-run must not delete the first run's data); only the content
   * hash and display key move. Rows within one call must be distinct on (externalType, externalId).
   */
  async upsertMany(
    connectionId: string,
    importJobId: string,
    refs: readonly NewExternalRef[],
    db: Db = this.prisma,
  ): Promise<ExternalRefRow[]> {
    if (refs.length === 0) return [];
    const seen = new Set<string>();
    for (const r of refs) {
      const k = `${r.externalType}\u0000${r.externalId}`;
      if (seen.has(k)) {
        throw new Error(`upsertMany: duplicate ref ${r.externalType}:${r.externalId} in one call`);
      }
      seen.add(k);
    }
    const rows = await db.$queryRaw<
      Array<{
        external_type: string;
        external_id: string;
        local_type: string;
        local_id: string;
        content_hash: string | null;
        import_job_id: string;
        inserted: boolean;
      }>
    >(Prisma.sql`
      INSERT INTO external_refs
        (id, connection_id, import_job_id, external_type, external_id, external_key, local_type, local_id, content_hash, updated_at)
      SELECT t.id, ${connectionId}, ${importJobId}, t.external_type, t.external_id, t.external_key,
             t.local_type, t.local_id, t.content_hash, now()
      FROM unnest(
        ${refs.map(() => newEntityId())}::text[],
        ${refs.map((r) => r.externalType)}::text[],
        ${refs.map((r) => r.externalId)}::text[],
        ${refs.map((r) => r.externalKey ?? null)}::text[],
        ${refs.map((r) => r.localType)}::text[],
        ${refs.map((r) => r.localId)}::text[],
        ${refs.map((r) => r.contentHash ?? null)}::text[]
      ) AS t(id, external_type, external_id, external_key, local_type, local_id, content_hash)
      ON CONFLICT (connection_id, external_type, external_id) DO UPDATE
        SET content_hash = EXCLUDED.content_hash,
            external_key = COALESCE(EXCLUDED.external_key, external_refs.external_key),
            updated_at   = now()
      RETURNING external_type, external_id, local_type, local_id, content_hash, import_job_id,
                (xmax = 0) AS inserted
    `);
    return rows.map((r) => ({
      externalType: r.external_type,
      externalId: r.external_id,
      localType: r.local_type,
      localId: r.local_id,
      contentHash: r.content_hash,
      importJobId: r.import_job_id,
      inserted: r.inserted,
    }));
  }

  /** Rollback and the report read refs by the job that created them. Keyset-paged: never loads a whole import. */
  async pageByJob(
    importJobId: string,
    opts: { localType?: string; afterId?: string; take: number },
    db: Db = this.prisma,
  ) {
    return db.externalRef.findMany({
      where: {
        importJobId,
        ...(opts.localType ? { localType: opts.localType } : {}),
        ...(opts.afterId ? { id: { gt: opts.afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: opts.take,
    });
  }

  async countByLocalType(importJobId: string, db: Db = this.prisma): Promise<Record<string, number>> {
    const groups = await db.externalRef.groupBy({
      by: ['localType'],
      where: { importJobId },
      _count: { _all: true },
    });
    return Object.fromEntries(groups.map((g) => [g.localType, g._count._all]));
  }
}
