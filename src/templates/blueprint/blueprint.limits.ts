import { MAX_TASK_DEPTH } from '../../projects-tasks/tasks/task-tree';
import {
  MAX_WORKFLOW_STATUSES,
  STATUS_NAME_MAX_LENGTH,
} from '../../projects-tasks/workflow/workflow-rules';
import { MAX_ISSUE_TYPES_PER_WORKSPACE } from '../../projects-tasks/iterations/iteration-rules';
import { TAG_NAME_MAX_LENGTH } from '../../projects-tasks/tags/tag-name';

/**
 * Step 3.1. EVERY number the blueprint format enforces lives here, so the JSON Schema, the
 * semantic checks, the tests and docs/design/blueprint-v1.md quote one source.
 *
 * Where the application already has a limit for the same thing (task depth, status count,
 * tag/status name length, issue types) the value is IMPORTED, not copied: a blueprint must
 * never be valid with something the apply step would then refuse.
 */
export const BLUEPRINT_LIMITS = {
  /** Serialized size (UTF-8 bytes of the JSON text). Diagram 15: "max 2 MB". */
  maxBytes: 2 * 1024 * 1024,
  /**
   * "Nodes" = projects + tasks (every level) + iterations: the things that carry a `nodeKey`
   * and become rows the applier must write. Diagram 15: "<= 5 000 nodes".
   */
  maxNodes: 5000,
  /**
   * Structural JSON nesting (objects/arrays) accepted before any validator recursion starts.
   * Task nesting is far smaller; this only protects the recursive validators from a hostile
   * document. The deepest legal document is ~13 levels (see blueprint.validator.spec.ts).
   */
  maxJsonDepth: 20,
  /** Task levels, root included. Imported: ADR-0005 (root -> subtask -> sub-subtask = 3). */
  maxTaskLevels: MAX_TASK_DEPTH + 1,
  /** Reported issues are capped so a hostile document cannot make the error response huge. */
  maxIssues: 100,

  maxProjects: 50,
  maxVariables: 50,
  maxRoles: 30,
  maxModules: 50,
  maxModuleIncludes: 1000,
  maxTags: 200,
  maxCustomFields: 100,
  maxIssueTypes: MAX_ISSUE_TYPES_PER_WORKSPACE,
  maxIterations: 200,
  maxStatusesPerProject: MAX_WORKFLOW_STATUSES,
  /** n * (n - 1) with n = 30 would be 870; the service caps stored transitions at <= 900 rows. */
  maxTransitionsPerProject: 900,
  maxDependenciesPerProject: 2000,
  maxAutomationsPerProject: 50,
  maxViewsPerProject: 50,
  maxOpaqueItemBytes: 20 * 1024,
  maxAssets: 50,
  /** PROPOSED for 3.7 (template assets) - the format only needs a ceiling to validate against. */
  maxAssetBytes: 10 * 1024 * 1024,
  maxTotalAssetBytes: 50 * 1024 * 1024,

  maxCommentsPerTask: 50,
  maxTagsPerTask: 20,
  maxAssigneeRolesPerTask: 10,
  maxAttachmentsPerTask: 10,
  maxCustomValuesPerTask: 50,
  maxPlaceholdersPerString: 50,
  maxPlaceholderLength: 200,

  /** Offsets from the date anchor, in days: about +-10 years. */
  maxOffsetDays: 3650,
  maxEstimate: 1000,

  // text lengths - these match the DTOs the same field is written through today
  metaName: 120,
  metaDescription: 2000,
  workspaceName: 120,
  workspaceDescription: 2000,
  icon: 50,
  projectName: 120,
  projectDescription: 2000,
  taskTitle: 300,
  taskDescription: 10000,
  commentBody: 10000,
  iterationName: 200,
  iterationGoal: 2000,
  issueTypeName: 200,
  customFieldName: 80,
  customFieldKey: 80,
  customOption: 200,
  maxCustomOptions: 100,
  customTextValue: 2000,
  customUrlValue: 2048,
  tagName: TAG_NAME_MAX_LENGTH,
  statusName: STATUS_NAME_MAX_LENGTH,
  variableLabel: 80,
  variableTextDefault: 500,
  variableOption: 100,
  maxVariableOptions: 50,
  roleLabel: 80,
  moduleLabel: 80,
  fileName: 255,
  mimeType: 127,
} as const;
