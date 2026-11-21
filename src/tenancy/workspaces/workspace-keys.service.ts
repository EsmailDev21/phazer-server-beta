import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma, Workspace } from '@prisma/client';
import { AuditLogService } from '../../events/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  normalizeWorkspaceKey,
  parseTaskKey,
  pickUniqueKey,
} from './workspace-key';

type Db = Prisma.TransactionClient | PrismaService;

/** Held until the surrounding transaction ends. Must be called inside one. */
export async function lockAccountKeys(
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<void> {
  // $executeRaw, not $queryRaw: the function returns `void`, a column type
  // Prisma cannot deserialize. We only want the lock, not a result.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace-keys:${accountId}`}, 0))`;
}

/** Every key the account has used: current keys and retired aliases. */
export async function takenKeys(
  db: Db,
  accountId: string,
): Promise<Set<string>> {
  const [workspaces, aliases] = await Promise.all([
    db.workspace.findMany({ where: { accountId }, select: { key: true } }),
    db.workspaceKeyAlias.findMany({
      where: { accountId },
      select: { key: true },
    }),
  ]);
  return new Set([
    ...workspaces.map((w) => w.key),
    ...aliases.map((a) => a.key),
  ]);
}

export interface ResolvedWorkspaceKey {
  workspaceId: string;
  /** The workspace's key TODAY, which differs from the one asked for when it was renamed. */
  currentKey: string | null;
  viaAlias: boolean;
}

export interface ResolvedTaskKey extends ResolvedWorkspaceKey {
  taskId: string;
  number: number;
}

/**
 * ADR-0004. Everything that decides what a workspace's key is, and how a key
 * is turned back into a workspace. Nothing else writes `Workspace.key`.
 *
 * SERIALISATION. A key is unique among an account's CURRENT keys (one index)
 * and also reserved by its RETIRED keys (another table): two tables, so no
 * single index can arbitrate between them. Every operation that assigns a key
 * therefore takes a transaction-scoped advisory lock for the account first.
 * What that demonstrably buys (tests fail without it): concurrent creates
 * choosing the same generated key, and concurrent renames into one key, resolve
 * as clean 409s/distinct keys instead of raw unique-violation errors. It also
 * closes a narrower window - a reader of "current keys" and "aliases" (two
 * queries) straddling another transaction's rename could in theory see a key as
 * free in both - which we could not provoke in testing, so the lock is the
 * guarantee rather than something we observed being needed. Key changes are
 * rare, so a per-account lock costs nothing.
 */
@Injectable()
export class WorkspaceKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  lockAccountKeys(
    tx: Prisma.TransactionClient,
    accountId: string,
  ): Promise<void> {
    return lockAccountKeys(tx, accountId);
  }

  takenKeys(db: Db, accountId: string): Promise<Set<string>> {
    return takenKeys(db, accountId);
  }

  /**
   * The key a new workspace gets. `requested` (already user-supplied) must be
   * free; otherwise one is generated from the name. MUST run inside the same
   * transaction that inserts the workspace, after lockAccountKeys.
   */
  async allocateKey(
    tx: Prisma.TransactionClient,
    accountId: string,
    name: string,
    requested?: string,
  ): Promise<string> {
    await this.lockAccountKeys(tx, accountId);
    const taken = await this.takenKeys(tx, accountId);
    if (requested !== undefined) {
      const key = normalizeWorkspaceKey(requested);
      if (taken.has(key)) {
        throw new ConflictException(
          `The key ${key} is already used or reserved in this account`,
        );
      }
      return key;
    }
    return pickUniqueKey(name, taken);
  }

  /**
   * Changes a workspace's key. The old key stays RESERVED and RESOLVABLE (an
   * alias), so references made before the rename keep working and nobody else
   * in the account can take it. Renaming back to one of the workspace's own
   * retired keys is allowed and simply promotes it again.
   */
  async rename(
    workspaceId: string,
    rawKey: string,
    actorId: string,
  ): Promise<Workspace> {
    const newKey = normalizeWorkspaceKey(rawKey);

    const { workspace, changed, previous } = await this.prisma.$transaction(
      async (tx) => {
        const found = await tx.workspace.findUnique({
          where: { id: workspaceId },
          select: { accountId: true },
        });
        if (!found) throw new NotFoundException('Workspace not found');

        await this.lockAccountKeys(tx, found.accountId);
        // Re-read under the lock: the key may have changed while we waited for it.
        const current = await tx.workspace.findUnique({
          where: { id: workspaceId },
        });
        if (!current) throw new NotFoundException('Workspace not found');
        if (current.key === newKey) {
          return { workspace: current, changed: false, previous: current.key };
        }

        const holder = await tx.workspace.findFirst({
          where: {
            accountId: current.accountId,
            key: newKey,
            NOT: { id: workspaceId },
          },
          select: { id: true },
        });
        if (holder) {
          throw new ConflictException(
            `The key ${newKey} is used by another workspace in this account`,
          );
        }
        const alias = await tx.workspaceKeyAlias.findUnique({
          where: {
            accountId_key: { accountId: current.accountId, key: newKey },
          },
        });
        if (alias && alias.workspaceId !== workspaceId) {
          throw new ConflictException(
            `The key ${newKey} is reserved: another workspace in this account used it before`,
          );
        }
        if (alias)
          await tx.workspaceKeyAlias.delete({ where: { id: alias.id } });

        if (current.key) {
          await tx.workspaceKeyAlias.create({
            data: {
              accountId: current.accountId,
              key: current.key,
              workspaceId,
            },
          });
        }
        const updated = await tx.workspace.update({
          where: { id: workspaceId },
          data: { key: newKey },
        });
        return { workspace: updated, changed: true, previous: current.key };
      },
    );

    // Only after commit, and only for a real change (a no-op rename is silent).
    if (changed) {
      await this.auditLog.record({
        actorId,
        accountId: workspace.accountId,
        action: AuditAction.WORKSPACE_KEY_CHANGED,
        metadata: { workspaceId, from: previous, to: newKey },
      });
    }
    return workspace;
  }

  /** Current key first, then retired aliases (ADR-0004 decision 4). */
  async resolve(
    db: Db,
    accountId: string,
    rawKey: string,
  ): Promise<ResolvedWorkspaceKey | null> {
    let key: string;
    try {
      key = normalizeWorkspaceKey(rawKey);
    } catch {
      return null; // not a well-formed key: cannot match anything
    }
    const current = await db.workspace.findUnique({
      where: { accountId_key: { accountId, key } },
      select: { id: true, key: true },
    });
    if (current)
      return {
        workspaceId: current.id,
        currentKey: current.key,
        viaAlias: false,
      };

    const alias = await db.workspaceKeyAlias.findUnique({
      where: { accountId_key: { accountId, key } },
      select: { workspace: { select: { id: true, key: true } } },
    });
    if (alias) {
      return {
        workspaceId: alias.workspace.id,
        currentKey: alias.workspace.key,
        viaAlias: true,
      };
    }
    return null;
  }

  /** "ENG-123" within an account -> the task, or null. Never throws on bad input. */
  async resolveTask(
    db: Db,
    accountId: string,
    taskKey: string,
  ): Promise<ResolvedTaskKey | null> {
    const parsed = parseTaskKey(taskKey);
    if (!parsed) return null;
    const ws = await this.resolve(db, accountId, parsed.key);
    if (!ws) return null;
    const task = await db.task.findFirst({
      where: { workspaceId: ws.workspaceId, number: parsed.number },
      select: { id: true },
    });
    return task ? { ...ws, taskId: task.id, number: parsed.number } : null;
  }
}
