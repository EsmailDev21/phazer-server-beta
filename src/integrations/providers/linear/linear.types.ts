/**
 * Step 4.5. The shapes of Linear's GraphQL responses that the adapter reads (only the fields it asks for). Everything here is
 * UNTRUSTED provider data: the normalizers read it defensively and the result still goes through validateBundle.
 */
export interface GqlError {
  message?: string;
  extensions?: { code?: string; type?: string; userPresentableMessage?: string };
}

export interface GqlEnvelope<T> {
  data?: T | null;
  errors?: GqlError[];
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

export interface Connection<N> {
  nodes: N[];
  pageInfo: PageInfo;
}

export interface LinearOrganization {
  id: string;
  name: string;
  urlKey: string;
}

export interface LinearTeamLite {
  id: string;
  key: string;
  name: string;
}

export interface LinearTeam extends LinearTeamLite {
  description?: string | null;
}

export interface LinearUser {
  id: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
  active?: boolean;
  /** true for an OAuth application's own user. */
  app?: boolean;
  avatarUrl?: string | null;
}

export type LinearStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | string;

export interface LinearState {
  id: string;
  name: string;
  type: LinearStateType;
  color?: string | null;
  position?: number | null;
}

export interface LinearCycle {
  id: string;
  number?: number | null;
  name?: string | null;
  description?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface LinearProject {
  id: string;
  name: string;
}

export interface LinearLabel {
  id?: string;
  name: string;
  color?: string | null;
}

export interface LinearRelation {
  id: string;
  /** 'blocks' | 'duplicate' | 'related' | 'similar' */
  type: string;
  relatedIssue?: { id: string; identifier?: string | null; title?: string | null; team?: { id: string } | null } | null;
}

export interface LinearIssue {
  id: string;
  identifier?: string | null;
  url?: string | null;
  title: string;
  description?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  estimate?: number | null;
  dueDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
  state?: { id: string } | null;
  assignee?: { id: string } | null;
  creator?: { id: string } | null;
  parent?: { id: string } | null;
  cycle?: { id: string } | null;
  project?: { id: string; name: string } | null;
  labels?: { nodes?: LinearLabel[]; pageInfo?: PageInfo } | null;
  relations?: { nodes?: LinearRelation[]; pageInfo?: PageInfo } | null;
  // step 4.6, present only when the matching option is on
  comments?: { nodes?: LinearComment[]; pageInfo?: PageInfo } | null;
  history?: { nodes?: LinearHistoryNode[]; pageInfo?: PageInfo } | null;
  attachments?: { nodes?: LinearLinkAttachment[]; pageInfo?: PageInfo } | null;
}

// ---- step 4.6: comments, history, attachments (field names from Linear's public schema; see ADR-0035 for what is unverified)

export interface LinearComment {
  id: string;
  body?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  editedAt?: string | null;
  user?: { id: string; name?: string | null } | null;
  /** A comment written by an integration / bot has no `user`. */
  botActor?: { name?: string | null } | null;
  externalUser?: { name?: string | null } | null;
  parent?: { id: string } | null;
}

/** One Linear history record: ONE moment, possibly several changes at once (state and assignee in one edit). */
export interface LinearHistoryNode {
  id: string;
  createdAt?: string | null;
  actor?: { id: string } | null;
  fromState?: { name?: string | null } | null;
  toState?: { name?: string | null } | null;
  fromAssignee?: { name?: string | null } | null;
  toAssignee?: { name?: string | null } | null;
  fromPriority?: number | null;
  toPriority?: number | null;
  fromEstimate?: number | null;
  toEstimate?: number | null;
  fromCycle?: { name?: string | null; number?: number | null } | null;
  toCycle?: { name?: string | null; number?: number | null } | null;
  fromProject?: { name?: string | null } | null;
  toProject?: { name?: string | null } | null;
  fromParent?: { identifier?: string | null } | null;
  toParent?: { identifier?: string | null } | null;
  fromTitle?: string | null;
  toTitle?: string | null;
  fromDueDate?: string | null;
  toDueDate?: string | null;
  addedLabels?: Array<{ name?: string | null }> | null;
  removedLabels?: Array<{ name?: string | null }> | null;
  archived?: boolean | null;
  updatedDescription?: boolean | null;
}

/** Linear's own "attachment": a LINK to something elsewhere (a pull request, a Slack thread, a Figma file). Not a file. */
export interface LinearLinkAttachment {
  id: string;
  title?: string | null;
  subtitle?: string | null;
  url?: string | null;
}

export interface LinearIssueContent {
  comments?: { nodes?: LinearComment[]; pageInfo?: PageInfo } | null;
  history?: { nodes?: LinearHistoryNode[]; pageInfo?: PageInfo } | null;
  attachments?: { nodes?: LinearLinkAttachment[]; pageInfo?: PageInfo } | null;
}
