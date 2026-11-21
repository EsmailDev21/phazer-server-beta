/**
 * Raw Jira Cloud REST v3 / Agile shapes, as far as the importer reads them (ADR-0037). Written from Atlassian's public
 * documentation and third-party typed clients; every field is optional because none of it was checked against a live site.
 */
export interface JiraUser {
  accountId?: string;
  displayName?: string | null;
  emailAddress?: string | null;
  /** 'atlassian' | 'app' | 'customer' */
  accountType?: string | null;
  active?: boolean;
}

export interface JiraStatus {
  id: string;
  name: string;
  /** key: 'new' | 'indeterminate' | 'done' | 'undefined' */
  statusCategory?: { key?: string | null; name?: string | null } | null;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask?: boolean;
  hierarchyLevel?: number | null;
  description?: string | null;
}

export interface JiraProject {
  id: string;
  key: string;
  name?: string | null;
  description?: string | null;
  archived?: boolean;
  projectTypeKey?: string | null;
}

export interface JiraFieldDef {
  id: string;
  name: string;
  custom?: boolean;
  schema?: { type?: string; items?: string; custom?: string; system?: string } | null;
}

export interface JiraComment {
  id: string;
  author?: JiraUser | null;
  /** ADF document. */
  body?: unknown;
  created?: string | null;
  updated?: string | null;
}

export interface JiraAttachment {
  id: string;
  filename?: string | null;
  size?: number | null;
  mimeType?: string | null;
  created?: string | null;
  author?: JiraUser | null;
}

export interface JiraLink {
  id: string;
  type?: { name?: string | null; inward?: string | null; outward?: string | null } | null;
  inwardIssue?: { id: string; key?: string; fields?: { summary?: string | null } } | null;
  outwardIssue?: { id: string; key?: string; fields?: { summary?: string | null } } | null;
}

export interface JiraHistoryItem {
  field?: string;
  fieldId?: string | null;
  fromString?: string | null;
  toString?: string | null;
}

export interface JiraHistory {
  id: string;
  created?: string | null;
  author?: JiraUser | null;
  items?: JiraHistoryItem[] | null;
}

export interface JiraSprint {
  id: number | string;
  name?: string | null;
  state?: string | null;
  goal?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  completeDate?: string | null;
}

export interface JiraVersion {
  id: string;
  name?: string | null;
  description?: string | null;
  released?: boolean;
  releaseDate?: string | null;
  startDate?: string | null;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown> & {
    summary?: string | null;
    description?: unknown;
    environment?: unknown;
    status?: JiraStatus | null;
    priority?: { id?: string; name?: string | null } | null;
    issuetype?: JiraIssueType | null;
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    creator?: JiraUser | null;
    labels?: string[] | null;
    components?: Array<{ name?: string | null }> | null;
    fixVersions?: JiraVersion[] | null;
    duedate?: string | null;
    created?: string | null;
    updated?: string | null;
    parent?: { id?: string } | null;
    issuelinks?: JiraLink[] | null;
    attachment?: JiraAttachment[] | null;
    comment?: { comments?: JiraComment[]; total?: number } | null;
    timeoriginalestimate?: number | null;
    timespent?: number | null;
  };
  changelog?: { histories?: JiraHistory[]; total?: number } | null;
}

export interface JiraResource {
  id: string;
  name?: string | null;
  url?: string | null;
  scopes?: string[] | null;
}
