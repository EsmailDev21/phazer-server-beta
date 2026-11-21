import { FieldType, TaskStatus } from '@prisma/client';

/**
 * Step 5.5. Automations and saved views inside a blueprint. Ids do not exist in a template, so the
 * portable form names things the way the rest of the blueprint does:
 *   status -> the project's workflow status key      tag -> the tag name      issue type -> its name
 *   custom field -> its key                          iteration / project -> nodeKey
 *   people -> only the tokens (rules: TRIGGERER / CREATOR; views: ME), never a user id
 * The SHAPE is otherwise exactly the rule / view-config DSL, with the id-carrying strings holding names.
 * An item without a recognised `kind` stays what it always was: opaque JSON, carried untouched.
 */
export const RULE_KIND = 'rule.v1';
export const VIEW_KIND = 'view.v1';

export interface PortableRule {
  kind: typeof RULE_KIND;
  name: string;
  trigger: Record<string, unknown>;
  conditions?: Record<string, unknown>;
  actions: unknown[];
}

export interface PortableView {
  kind: typeof VIEW_KIND;
  name: string;
  layout: string;
  /** A wish, not a right: honoured only when the person applying the template is an admin. */
  shared?: boolean;
  config: Record<string, unknown>;
}

export type ItemClass = 'rule' | 'view' | 'raw';

/** What a name refers to. */
export type RefKind =
  | 'status'
  | 'tag'
  | 'issueType'
  | 'customField'
  | 'iteration'
  | 'project'
  | 'user'
  | 'channel'
  | 'rule'
  | 'view';

/** One thing a template can name, with what the semantic checks need to know about it. */
export interface EntityModel {
  tags: Array<{ name: string; id: string }>;
  issueTypes: Array<{ name: string; id: string }>;
  /** A field the apply would SKIP (type conflict) is simply absent. */
  customFields: Array<{
    key: string;
    id: string;
    dataType: FieldType;
    options: string[] | null;
  }>;
  iterations: Array<{ nodeKey: string; id: string }>;
  projects: Array<{ nodeKey: string; id: string }>;
  statuses: Array<{
    projectKey: string;
    key: string;
    id: string;
    category: TaskStatus;
  }>;
}

export interface RefIssue {
  code: 'UNKNOWN_REF' | 'NOT_PORTABLE';
  path: string;
  message: string;
}
