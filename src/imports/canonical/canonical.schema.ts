import { DependencyType, FieldType, IssueTypeLevel, IterationKind } from '@prisma/client';
import { CANONICAL_LIMITS as L } from './canonical.limits';
import { CANONICAL_SCHEMA_VERSION } from './canonical.types';

/**
 * Step 4.2. JSON Schema (draft-07, ajv STRICT) of one CanonicalBundle page: the SHAPE contract.
 *
 * It is the FINAL GATE, not the first filter. Provider data is messy (a 5 000-character title, a stray control
 * character), so the validator repairs and skips item by item first (canonical.validator.ts) and only then runs this on
 * what is left. If the repaired page still fails, the adapter emitted something the format does not have: that is an
 * ADAPTER_BUG, loud and early, instead of a corrupt row later. Every object is closed (additionalProperties: false).
 */
export const INSTANT_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
export const HEX_COLOR_PATTERN = '^#[0-9a-fA-F]{6}$';
export const MIME_PATTERN = '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$';
export const SYSTEM_PATTERN = '^[a-z][a-z0-9_-]{0,39}$';
export const STATUS_CATEGORIES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE', 'CANCELED', 'UNKNOWN'] as const;

const text = (max: number, min = 1) => ({ type: 'string', minLength: min, maxLength: max });
const id = text(L.externalId);
const instant = { type: 'string', pattern: INSTANT_PATTERN };
const url = text(L.url);
const color = { type: 'string', pattern: HEX_COLOR_PATTERN };
const list = (items: unknown, maxItems: number) => ({ type: 'array', maxItems, items });
const enumOf = (values: readonly string[]) => ({ type: 'string', enum: [...values] });
const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const user = obj(
  {
    externalId: id,
    name: text(L.userName),
    email: text(L.email),
    avatarUrl: url,
    isBot: { type: 'boolean' },
  },
  ['externalId', 'name'],
);

const status = obj(
  {
    externalId: id,
    name: text(L.statusName),
    category: enumOf(STATUS_CATEGORIES),
    color,
    position: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000 },
  },
  ['externalId', 'name', 'category'],
);

const project = obj(
  {
    externalId: id,
    key: text(L.externalKey),
    name: text(L.projectName),
    description: text(L.projectDescription, 0),
    url,
    archived: { type: 'boolean' },
    createdAt: instant,
    statuses: list(status, L.maxStatusesPerProject),
  },
  ['externalId', 'name'],
);

const tag = obj({ name: text(L.tagName), color }, ['name']);

const customField = obj(
  {
    externalId: id,
    name: text(L.customFieldName),
    dataType: enumOf(Object.values(FieldType)),
    options: list(obj({ externalId: id, label: text(L.customOption) }, ['label']), L.maxCustomOptions),
  },
  ['externalId', 'name', 'dataType'],
);

const issueType = obj(
  {
    externalId: id,
    name: text(L.issueTypeName),
    level: enumOf(Object.values(IssueTypeLevel)),
    color,
  },
  ['externalId', 'name'],
);

const iteration = obj(
  {
    externalId: id,
    kind: enumOf(Object.values(IterationKind)),
    name: text(L.iterationName),
    goal: text(L.iterationGoal, 0),
    startDate: instant,
    endDate: instant,
    projectExternalId: id,
  },
  ['externalId', 'kind', 'name'],
);

const customValue = obj(
  {
    fieldExternalId: id,
    value: {
      anyOf: [
        text(L.customTextValue, 0),
        { type: 'number' },
        { type: 'boolean' },
        list(text(L.customOption), L.maxCustomOptions),
      ],
    },
  },
  ['fieldExternalId', 'value'],
);

const comment = obj(
  {
    externalId: id,
    authorExternalId: id,
    authorName: text(L.userName),
    body: text(L.commentBody),
    createdAt: instant,
    editedAt: instant,
    parentExternalId: id,
  },
  ['externalId', 'body'],
);

const attachment = obj(
  {
    externalId: id,
    fileName: text(L.fileName),
    mimeType: { type: 'string', maxLength: L.mimeType, pattern: MIME_PATTERN },
    sizeBytes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    providerRef: text(L.providerRef),
    uploaderExternalId: id,
    createdAt: instant,
  },
  ['externalId', 'fileName', 'providerRef'],
);

const history = obj(
  {
    externalId: id,
    actorExternalId: id,
    at: instant,
    field: text(L.historyField),
    from: { type: ['string', 'null'], maxLength: L.historyValue },
    to: { type: ['string', 'null'], maxLength: L.historyValue },
  },
  ['externalId', 'at', 'field'],
);

const task = obj(
  {
    externalId: id,
    key: text(L.externalKey),
    url,
    projectExternalId: id,
    parentExternalId: id,
    title: text(L.title),
    description: text(L.description, 0),
    statusExternalId: id,
    priority: text(L.priority),
    issueTypeExternalId: id,
    tags: list(text(L.tagName), L.maxTagsPerTask),
    customValues: list(customValue, L.maxCustomValuesPerTask),
    assigneeExternalIds: list(id, L.maxAssigneesPerTask),
    creatorExternalId: id,
    createdAt: instant,
    updatedAt: instant,
    startDate: instant,
    dueDate: instant,
    estimate: { type: 'number', minimum: 0, maximum: L.maxEstimate },
    iterationExternalId: id,
    archived: { type: 'boolean' },
    comments: list(comment, L.maxCommentsPerTask),
    attachments: list(attachment, L.maxAttachmentsPerTask),
    history: list(history, L.maxHistoryPerTask),
  },
  ['externalId', 'title'],
);

const dependency = obj(
  {
    externalId: id,
    fromExternalId: id,
    toExternalId: id,
    type: enumOf(Object.values(DependencyType)),
  },
  ['externalId', 'fromExternalId', 'toExternalId', 'type'],
);

export const CANONICAL_V1_SCHEMA = {
  $id: 'canonical-bundle-v1',
  ...obj(
    {
      schemaVersion: { const: CANONICAL_SCHEMA_VERSION },
      source: obj(
        {
          system: { type: 'string', pattern: SYSTEM_PATTERN },
          displayName: text(L.displayName),
        },
        ['system', 'displayName'],
      ),
      users: list(user, L.maxUsers),
      projects: list(project, L.maxProjects),
      tags: list(tag, L.maxTags),
      customFields: list(customField, L.maxCustomFields),
      issueTypes: list(issueType, L.maxIssueTypes),
      iterations: list(iteration, L.maxIterations),
      tasks: list(task, L.maxTasks),
      dependencies: list(dependency, L.maxDependencies),
    },
    ['schemaVersion', 'source'],
  ),
};
