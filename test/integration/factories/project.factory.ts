import type { PrismaService } from '../../../src/prisma/prisma.service';
import type { Project, ProjectMember, Prisma, Role } from '@prisma/client';
import { nextSeq } from './sequence';

export type ProjectOverrides = Partial<
  Omit<Prisma.ProjectUncheckedCreateInput, 'workspaceId' | 'createdById'>
>;

/**
 * Mirrors what ProjectsService.create does (ADR-0006 decision 2): a project is born
 * with its four default statuses and points at "To Do". Written with plain Prisma,
 * not WorkflowService, so the factory does not depend on the code under test.
 * Pass `seedWorkflow: false` for a project that must predate step 1.4.
 */
export async function createProject(
  prisma: PrismaService,
  params: {
    workspaceId: string;
    createdById: string;
    seedWorkflow?: boolean;
  } & ProjectOverrides,
): Promise<Project> {
  const {
    workspaceId,
    createdById,
    seedWorkflow = true,
    ...overrides
  } = params;
  const data: Prisma.ProjectUncheckedCreateInput = {
    workspaceId,
    createdById,
    name: `Test Project ${nextSeq()}`,
    ...overrides,
  };
  const project = await prisma.project.create({ data });
  if (!seedWorkflow) return project;
  const defs = [
    ['To Do', '#94A3B8', 'TODO'],
    ['In Progress', '#3B82F6', 'IN_PROGRESS'],
    ['Blocked', '#EF4444', 'BLOCKED'],
    ['Done', '#22C55E', 'DONE'],
  ] as const;
  const ids: string[] = [];
  for (const [i, [name, color, category]] of defs.entries()) {
    const row = await prisma.workflowStatus.create({
      data: {
        projectId: project.id,
        name,
        nameKey: name.toLowerCase(),
        color,
        position: i,
        category,
        isDefault: true,
      },
    });
    ids.push(row.id);
  }
  return prisma.project.update({
    where: { id: project.id },
    data: { defaultWorkflowStatusId: ids[0] },
  });
}

export function addProjectMember(
  prisma: PrismaService,
  params: { projectId: string; userId: string; role?: Role },
): Promise<ProjectMember> {
  return prisma.projectMember.create({
    data: {
      projectId: params.projectId,
      userId: params.userId,
      role: params.role,
    },
  });
}
