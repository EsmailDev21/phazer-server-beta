import {
  DependencyType,
  FieldType,
  IssueTypeLevel,
  IterationKind,
  Priority,
  TaskStatus,
} from '@prisma/client';
import { BLUEPRINT_LIMITS as L } from './blueprint.limits';
import { BLUEPRINT_SCHEMA_VERSION } from './blueprint.types';

/**
 * Step 3.1. The JSON Schema of Blueprint v1 (draft-07, compiled by ajv in STRICT mode).
 *
 * Rules this schema enforces by construction:
 *  - EVERY object is closed (`additionalProperties: false`): an unknown field is an error, not
 *    ignored. The only open objects are `extensions` (keys pattern-checked) and the reserved
 *    opaque `automations` / `views` items.
 *  - every array and string has a ceiling taken from BLUEPRINT_LIMITS.
 *
 * It is the SHAPE contract only. References, uniqueness, placeholders, cycles, date arithmetic,
 * node count and byte size are checked by blueprint.validator.ts. A copy of this schema is
 * committed as docs/design/blueprint-v1.schema.json (a test fails when they drift) for tools
 * that are not TypeScript.
 */

export const PATTERNS = {
  nodeKey: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$',
  variableKey: '^[A-Za-z][A-Za-z0-9_]{0,39}$',
  localKey: '^[a-z0-9][a-z0-9_-]{0,39}$',
  fieldKey: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$',
  hexColor: '^#[0-9a-fA-F]{6}$',
  workspaceKey: '^[A-Z][A-Z0-9]{1,9}$',
  sha256: '^[0-9a-f]{64}$',
  mimeType: '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$',
  category: '^[a-z][a-z0-9-]{0,39}$',
  locale: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$',
  extensionKey: '^[a-z][a-z0-9._-]{0,63}$',
} as const;

const text = (max: number, min = 1) => ({
  type: 'string',
  minLength: min,
  maxLength: max,
});
const key = (pattern: string) => ({ type: 'string', pattern });
const stringArray = (itemMax: number, maxItems: number, minItems = 0) => ({
  type: 'array',
  minItems,
  maxItems,
  items: text(itemMax),
});
const enumOf = (values: readonly string[]) => ({
  type: 'string',
  enum: [...values],
});
const offset = {
  type: 'integer',
  minimum: -L.maxOffsetDays,
  maximum: L.maxOffsetDays,
};
const list = (items: unknown, maxItems: number, minItems = 0) => ({
  type: 'array',
  minItems,
  maxItems,
  items,
});
const closed = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});
const opaqueItem = {
  type: 'object',
  additionalProperties: true,
  maxProperties: 100,
};

export const BLUEPRINT_V1_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://schemas.invalid/blueprint/v1.json',
  title: 'Blueprint v1',
  ...closed(
    {
      schemaVersion: { const: BLUEPRINT_SCHEMA_VERSION },
      meta: { $ref: '#/$defs/meta' },
      dateAnchor: { $ref: '#/$defs/dateAnchor' },
      variables: list({ $ref: '#/$defs/variable' }, L.maxVariables),
      roles: list({ $ref: '#/$defs/role' }, L.maxRoles),
      modules: list({ $ref: '#/$defs/module' }, L.maxModules),
      workspace: { $ref: '#/$defs/workspace' },
      projects: list({ $ref: '#/$defs/project' }, L.maxProjects),
      assets: list({ $ref: '#/$defs/asset' }, L.maxAssets),
      extensions: {
        type: 'object',
        propertyNames: { pattern: PATTERNS.extensionKey },
        additionalProperties: true,
      },
    },
    ['schemaVersion', 'meta', 'projects'],
  ),
  $defs: {
    meta: closed(
      {
        name: text(L.metaName),
        description: text(L.metaDescription),
        kind: enumOf(['WORKSPACE', 'PROJECT']),
        category: key(PATTERNS.category),
        locale: key(PATTERNS.locale),
      },
      ['name', 'kind'],
    ),
    dateAnchor: closed({
      variable: key(PATTERNS.variableKey),
      skipWeekends: { type: 'boolean' },
    }),
    variable: closed(
      {
        key: key(PATTERNS.variableKey),
        label: text(L.variableLabel),
        type: enumOf(['TEXT', 'DATE', 'NUMBER', 'SELECT', 'BOOLEAN']),
        default: { type: ['string', 'number', 'boolean'] },
        options: stringArray(L.variableOption, L.maxVariableOptions, 1),
        required: { type: 'boolean' },
      },
      ['key', 'label', 'type'],
    ),
    role: closed(
      {
        key: key(PATTERNS.localKey),
        label: text(L.roleLabel),
        suggestedAccess: enumOf(['ADMIN', 'MEMBER', 'VIEWER']),
      },
      ['key', 'label'],
    ),
    module: closed(
      {
        key: key(PATTERNS.localKey),
        label: text(L.moduleLabel),
        defaultEnabled: { type: 'boolean' },
        includes: list(key(PATTERNS.nodeKey), L.maxModuleIncludes, 1),
      },
      ['key', 'label', 'includes'],
    ),
    workspace: closed({
      name: text(L.workspaceName),
      key: key(PATTERNS.workspaceKey),
      icon: text(L.icon),
      description: text(L.workspaceDescription),
      tags: list(closed({ name: text(L.tagName) }, ['name']), L.maxTags),
      customFields: list(
        closed(
          {
            key: key(PATTERNS.fieldKey),
            name: text(L.customFieldName),
            dataType: enumOf(Object.values(FieldType)),
            options: stringArray(L.customOption, L.maxCustomOptions, 1),
            order: { type: 'integer', minimum: 0, maximum: 100000 },
          },
          ['key', 'name', 'dataType'],
        ),
        L.maxCustomFields,
      ),
      issueTypes: list(
        closed(
          {
            name: text(L.issueTypeName),
            icon: text(L.icon),
            color: key(PATTERNS.hexColor),
            level: enumOf(Object.values(IssueTypeLevel)),
          },
          ['name'],
        ),
        L.maxIssueTypes,
      ),
      iterations: list(
        closed(
          {
            nodeKey: key(PATTERNS.nodeKey),
            kind: enumOf(Object.values(IterationKind)),
            name: text(L.iterationName),
            goal: text(L.iterationGoal),
            startOffsetDays: offset,
            endOffsetDays: offset,
            project: key(PATTERNS.nodeKey),
          },
          ['nodeKey', 'kind', 'name'],
        ),
        L.maxIterations,
      ),
    }),
    project: closed(
      {
        nodeKey: key(PATTERNS.nodeKey),
        name: text(L.projectName),
        description: text(L.projectDescription),
        workflow: closed(
          {
            statuses: list(
              closed(
                {
                  key: key(PATTERNS.localKey),
                  name: text(L.statusName),
                  category: enumOf(Object.values(TaskStatus)),
                  color: key(PATTERNS.hexColor),
                  excludeFromProgress: { type: 'boolean' },
                  isDefault: { type: 'boolean' },
                },
                ['key', 'name', 'category'],
              ),
              L.maxStatusesPerProject,
              1,
            ),
            transitions: list(
              closed(
                {
                  from: key(PATTERNS.localKey),
                  to: key(PATTERNS.localKey),
                },
                ['from', 'to'],
              ),
              L.maxTransitionsPerProject,
            ),
            enforceTransitions: { type: 'boolean' },
          },
          ['statuses'],
        ),
        tasks: list({ $ref: '#/$defs/task' }, L.maxNodes),
        dependencies: list(
          closed(
            {
              from: key(PATTERNS.nodeKey),
              to: key(PATTERNS.nodeKey),
              type: enumOf(Object.values(DependencyType)),
            },
            ['from', 'to'],
          ),
          L.maxDependenciesPerProject,
        ),
        automations: list(opaqueItem, L.maxAutomationsPerProject),
        views: list(opaqueItem, L.maxViewsPerProject),
      },
      ['nodeKey', 'name', 'tasks'],
    ),
    task: closed(
      {
        nodeKey: key(PATTERNS.nodeKey),
        title: text(L.taskTitle),
        description: text(L.taskDescription),
        issueType: text(L.issueTypeName),
        status: key(PATTERNS.localKey),
        priority: enumOf(Object.values(Priority)),
        tags: stringArray(L.tagName, L.maxTagsPerTask),
        customValues: {
          type: 'object',
          maxProperties: L.maxCustomValuesPerTask,
          propertyNames: { pattern: PATTERNS.fieldKey },
          additionalProperties: {},
        },
        assigneeRoles: list(key(PATTERNS.localKey), L.maxAssigneeRolesPerTask),
        startOffsetDays: offset,
        dueOffsetDays: offset,
        estimate: { type: 'number', minimum: 0, maximum: L.maxEstimate },
        iteration: key(PATTERNS.nodeKey),
        children: list({ $ref: '#/$defs/task' }, L.maxNodes),
        comments: list(
          closed(
            {
              body: text(L.commentBody),
              authorRole: key(PATTERNS.localKey),
            },
            ['body'],
          ),
          L.maxCommentsPerTask,
        ),
        attachments: list(key(PATTERNS.localKey), L.maxAttachmentsPerTask),
      },
      ['nodeKey', 'title'],
    ),
    asset: closed(
      {
        key: key(PATTERNS.localKey),
        fileName: text(L.fileName),
        mimeType: { ...text(L.mimeType), pattern: PATTERNS.mimeType },
        sizeBytes: { type: 'integer', minimum: 0, maximum: L.maxAssetBytes },
        sha256: key(PATTERNS.sha256),
      },
      ['key', 'fileName', 'mimeType', 'sizeBytes', 'sha256'],
    ),
  },
};
