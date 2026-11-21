/**
 * Response Contracts — Projects/Tasks graph, PT__CONTRACTS. Deliberately
 * split list vs detail shapes, both built via Prisma `select` (never
 * `include` + throwing rows away), replacing the old confirmed bug where
 * create/get/list/update all shared one giant include block regardless of
 * caller need.
 */

export interface ProjectListItemDto {
  id: string;
  name: string;
  status: string;
  workspaceId: string;
  taskCount: number; // _count, never a fetched array
  progress: number; // 0-100, computed via groupBy — see ProjectsService.computeProgress
}

export interface ProjectDetailDto extends ProjectListItemDto {
  description: string | null;
  memberCount: number;
  recentActivity: RecentActivityItem[]; // last 5 only, never the full Activity table
}

export interface RecentActivityItem {
  id: string;
  action: string;
  actorId: string | null;
  metadata: unknown;
  createdAt: Date;
}
