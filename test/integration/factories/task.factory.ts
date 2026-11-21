import type { PrismaService } from '../../../src/prisma/prisma.service';
import type { Task, Prisma } from '@prisma/client';
import { nextSeq } from './sequence';

// Task's factory needs the CHECKED variant, not Unchecked: assigning to the
// `assignees` many-to-many relation (`assignees: { connect: [...] }`, used by
// harness.int-spec.ts) is only expressible on TaskCreateInput, not on
// TaskUncheckedCreateInput.
export type TaskOverrides = Partial<
  Omit<Prisma.TaskCreateInput, 'workspace' | 'createdBy' | 'project' | 'number'>
> & {
  /** Step 1.1c: number is NOT NULL. Omit it to take the next one from the workspace counter. */
  number?: number;
};

export async function createTask(
  prisma: PrismaService,
  params: {
    workspaceId: string;
    createdById: string;
    projectId?: string;
  } & TaskOverrides,
): Promise<Task> {
  const { workspaceId, createdById, projectId, ...overrides } = params;
  const { number: explicitNumber, ...rest } = overrides;
  // ADR-0006 invariant: a task in a project carries the specific status of its
  // category. Resolved here (plain Prisma) unless the test names one itself.
  if (projectId && !('workflowStatus' in rest)) {
    const category = rest.status ?? 'TODO';
    const wf = await prisma.workflowStatus.findFirst({
      where: { projectId, category, isDefault: true },
      select: { id: true },
    });
    if (wf) {
      (rest as Record<string, unknown>).workflowStatus = {
        connect: { id: wf.id },
      };
    }
  }
  const data = {
    workspace: { connect: { id: workspaceId } },
    createdBy: { connect: { id: createdById } },
    ...(projectId ? { project: { connect: { id: projectId } } } : {}),
    title: `Test Task ${nextSeq()}`,
    ...rest,
  };
  // Same rule as TasksService.create: counter bump and insert in ONE transaction.
  return prisma.$transaction(async (tx) => {
    let number = explicitNumber;
    if (number === undefined) {
      const { nextTaskNumber } = await tx.workspace.update({
        where: { id: workspaceId },
        data: { nextTaskNumber: { increment: 1 } },
        select: { nextTaskNumber: true },
      });
      number = nextTaskNumber - 1;
    }
    return tx.task.create({
      data: { ...data, number } as Prisma.TaskCreateInput,
    });
  });
}
