import { BLUEPRINT_LIMITS as B } from '../../templates/blueprint/blueprint.limits';

/**
 * Step 4.2. Every number the CanonicalBundle format enforces.
 *
 * TEXT limits are the Blueprint's, imported (themselves imported from the app's own DTO limits): an imported title that
 * passed here must pass the write path. Page-shape limits are bundle-specific: a blueprint is a whole small document, a
 * bundle page is one slice of something huge, so counts are per PAGE and per-task nested counts are much higher.
 * Collections over their page ceiling are an ADAPTER bug (it chooses the page size) and fail the page; nested data over
 * its ceiling is the SOURCE's size and is truncated with a warning.
 */
export const CANONICAL_LIMITS = {
  /** Serialized JSON of one page. */
  maxPageBytes: 20 * 1024 * 1024,
  maxJsonDepth: 20,

  // per page
  maxUsers: 2000,
  maxProjects: 200,
  maxTags: 2000,
  maxCustomFields: 500,
  maxIssueTypes: B.maxIssueTypes,
  maxIterations: 1000,
  maxTasks: 1000,
  maxDependencies: 5000,

  // per project
  maxStatusesPerProject: B.maxStatusesPerProject,

  // per task (the source's data: truncate, don't fail)
  maxCommentsPerTask: 1000,
  maxAttachmentsPerTask: 100,
  maxHistoryPerTask: 2000,
  maxTagsPerTask: 50,
  maxAssigneesPerTask: 20,
  maxCustomValuesPerTask: 100,

  // text (same numbers the write path uses)
  title: B.taskTitle,
  description: B.taskDescription,
  commentBody: B.commentBody,
  projectName: B.projectName,
  projectDescription: B.projectDescription,
  iterationName: B.iterationName,
  iterationGoal: B.iterationGoal,
  issueTypeName: B.issueTypeName,
  customFieldName: B.customFieldName,
  customOption: B.customOption,
  maxCustomOptions: B.maxCustomOptions,
  customTextValue: B.customTextValue,
  customUrlValue: B.customUrlValue,
  tagName: B.tagName,
  statusName: B.statusName,
  fileName: B.fileName,
  mimeType: B.mimeType,
  maxEstimate: B.maxEstimate,

  // bundle-specific text
  externalId: 200,
  externalKey: 100,
  userName: 200,
  email: 320,
  url: 2048,
  providerRef: 2048,
  priority: 100,
  systemSlug: 40,
  displayName: 60,
  historyField: 60,
  historyValue: 500,
  color: 30,
  /** Instants outside this window are garbage ("0001-01-01", "9999-12-31"), not dates. */
  minYear: 1990,
  maxYear: 2100,
} as const;
