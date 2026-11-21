import { Injectable } from '@nestjs/common';
import { ActivityTargetType, Prisma } from '@prisma/client';

/**
 * Step 4.4 (import rollback). The delete side of ADR-0003's single door for tasks, projects and custom fields (the lint rule
 * covers deletes too). Every method takes the CALLER'S transaction and never deletes anything a person added since the import:
 * a task that gained a subtask, a project that gained a task, a field that gained a value is KEPT (returned as not deleted),
 * so a rollback can never destroy user data. Activity rows of what is deleted go with it (they point at it by id, no FK).
 */
@Injectable()
export class DomainEraser {
  /**
   * Deletes those of `ids` that have NO subtasks right now (imported or not). Call it repeatedly: each round frees the
   * parents of the previous one. Returns the ids actually deleted.
   */
  async deleteLeafTasks(tx: Prisma.TransactionClient, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const blocked = new Set(
      (await tx.task.findMany({ where: { parentId: { in: [...ids] } }, select: { parentId: true }, distinct: ['parentId'] })).map((t) => t.parentId as string),
    );
    const leaves = ids.filter((id) => !blocked.has(id));
    if (leaves.length === 0) return [];
    // read back what is really there (a concurrent delete is fine, a concurrent new child fails the FK and the batch retries)
    const { count } = await tx.task.deleteMany({ where: { id: { in: leaves } } });
    if (count > 0) await tx.activity.deleteMany({ where: { targetType: ActivityTargetType.TASK, targetId: { in: leaves } } });
    return leaves;
  }

  /** The project, only if nothing is left in it. Its workflow statuses and iterations go with it (cascade). */
  async deleteProjectIfEmpty(tx: Prisma.TransactionClient, projectId: string): Promise<boolean> {
    if ((await tx.task.count({ where: { projectId } })) > 0) return false;
    const { count } = await tx.project.deleteMany({ where: { id: projectId } });
    if (count > 0) await tx.activity.deleteMany({ where: { targetType: ActivityTargetType.PROJECT, targetId: projectId } });
    return true;
  }

  /** The custom field, only if no task has a value for it any more. */
  async deleteCustomFieldIfUnused(tx: Prisma.TransactionClient, fieldId: string): Promise<boolean> {
    if ((await tx.taskCustomValue.count({ where: { fieldId } })) > 0) return false;
    await tx.customField.deleteMany({ where: { id: fieldId } });
    return true;
  }
}
