/**
 * Step 4.5. Every GraphQL document the Linear adapter sends. READ-ONLY (queries only; there is no mutation in this adapter).
 *
 * Complexity (Linear's model, from its documentation, NOT measured against a live workspace): a scalar costs 0.1, an object 1,
 * and a connection multiplies its children by `first`. The issue page below asks for 50 issues with at most 10 labels and 10
 * relations each, which is roughly 3,000 points: well under the 10,000-point single-query ceiling, and one request per 50
 * issues. Raising ISSUE_PAGE_SIZE or the nested `first` values raises that cost linearly.
 */
export const ISSUE_PAGE_SIZE = 50;
export const NESTED_FIRST = 10;
export const LIST_PAGE_SIZE = 100;

export const Q_ORGANIZATION = /* GraphQL */ `
  query LinearOrganization {
    organization { id name urlKey }
  }
`;

export const Q_TEAMS = /* GraphQL */ `
  query LinearTeams($after: String) {
    teams(first: ${LIST_PAGE_SIZE}, after: $after) {
      nodes { id key name }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const Q_TEAM = /* GraphQL */ `
  query LinearTeam($id: String!) {
    team(id: $id) { id key name description }
  }
`;

export const Q_TEAM_STATES = /* GraphQL */ `
  query LinearTeamStates($id: String!, $after: String) {
    team(id: $id) {
      states(first: ${LIST_PAGE_SIZE}, after: $after) {
        nodes { id name type color position }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const Q_TEAM_CYCLES = /* GraphQL */ `
  query LinearTeamCycles($id: String!, $after: String) {
    team(id: $id) {
      cycles(first: ${LIST_PAGE_SIZE}, after: $after) {
        nodes { id number name description startsAt endsAt }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const Q_TEAM_PROJECTS = /* GraphQL */ `
  query LinearTeamProjects($id: String!, $after: String) {
    team(id: $id) {
      projects(first: ${LIST_PAGE_SIZE}, after: $after) {
        nodes { id name }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const Q_USERS = /* GraphQL */ `
  query LinearUsers($after: String) {
    users(first: ${LIST_PAGE_SIZE}, after: $after, includeDisabled: true) {
      nodes { id name displayName email active app avatarUrl }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const Q_LABELS = /* GraphQL */ `
  query LinearLabels($after: String) {
    issueLabels(first: ${LIST_PAGE_SIZE}, after: $after) {
      nodes { id name color }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Ids only: used to COUNT a team's issues for the estimate (no count field is relied on). */
export const Q_TEAM_ISSUE_IDS = /* GraphQL */ `
  query LinearTeamIssueIds($id: String!, $after: String) {
    team(id: $id) {
      issues(first: 250, after: $after, includeArchived: true) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const COMMENT_FIELDS = `id body createdAt updatedAt editedAt user { id name } botActor { name } externalUser { name } parent { id }`;
const HISTORY_FIELDS = `id createdAt actor { id }
  fromState { name } toState { name } fromAssignee { name } toAssignee { name } fromPriority toPriority fromEstimate toEstimate
  fromCycle { name number } toCycle { name number } fromProject { name } toProject { name } fromParent { identifier } toParent { identifier }
  fromTitle toTitle fromDueDate toDueDate addedLabels { name } removedLabels { name } archived updatedDescription`;
const LINK_FIELDS = `id title subtitle url`;

/**
 * Step 4.6. With comments / history / link attachments in the same page the cost per issue is far higher (history nodes carry
 * about a dozen sub-objects), so a content page is SMALLER: 10 issues x (25 comments x ~3 + 25 history x ~20 + ~60) is roughly
 * 6,500 points by the documented model (unmeasured; ADR-0035). If Linear answers "too complex" anyway the adapter halves the
 * page and remembers it in the cursor.
 */
export const CONTENT_PAGE_SIZE = 10;
export const CONTENT_NESTED_FIRST = 25;

export interface IssuePageShape {
  first: number;
  comments: boolean;
  history: boolean;
  links: boolean;
}

export function teamIssuesQuery(shape: IssuePageShape): string {
  const n = CONTENT_NESTED_FIRST;
  const extra = [
    shape.comments ? `comments(first: ${n}) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage endCursor } }` : '',
    shape.history ? `history(first: ${n}) { nodes { ${HISTORY_FIELDS} } pageInfo { hasNextPage endCursor } }` : '',
    shape.links ? `attachments(first: ${NESTED_FIRST}) { nodes { ${LINK_FIELDS} } pageInfo { hasNextPage endCursor } }` : '',
  ].join('\n          ');
  return /* GraphQL */ `
  query LinearTeamIssues($id: String!, $after: String) {
    team(id: $id) {
      issues(first: ${shape.first}, after: $after, includeArchived: true, orderBy: createdAt) {
        nodes {
          id identifier url title description priority priorityLabel estimate dueDate createdAt updatedAt archivedAt
          state { id }
          assignee { id }
          creator { id }
          parent { id }
          cycle { id }
          project { id name }
          labels(first: ${NESTED_FIRST}) { nodes { name } pageInfo { hasNextPage endCursor } }
          relations(first: ${NESTED_FIRST}) { nodes { id type relatedIssue { id identifier title team { id } } } pageInfo { hasNextPage endCursor } }
          ${extra}
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
}

export const Q_TEAM_ISSUES = /* GraphQL */ `
  query LinearTeamIssues($id: String!, $after: String) {
    team(id: $id) {
      issues(first: ${ISSUE_PAGE_SIZE}, after: $after, includeArchived: true, orderBy: createdAt) {
        nodes {
          id identifier url title description priority priorityLabel estimate dueDate createdAt updatedAt archivedAt
          state { id }
          assignee { id }
          creator { id }
          parent { id }
          cycle { id }
          project { id name }
          labels(first: ${NESTED_FIRST}) { nodes { name } pageInfo { hasNextPage endCursor } }
          relations(first: ${NESTED_FIRST}) { nodes { id type relatedIssue { id identifier title team { id } } } pageInfo { hasNextPage endCursor } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/** The rest of one issue's labels, for the (rare) issue that has more than NESTED_FIRST. */
export const Q_ISSUE_LABELS = /* GraphQL */ `
  query LinearIssueLabels($id: String!, $after: String) {
    issue(id: $id) {
      labels(first: ${LIST_PAGE_SIZE}, after: $after) {
        nodes { name }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const Q_ISSUE_RELATIONS = /* GraphQL */ `
  query LinearIssueRelations($id: String!, $after: String) {
    issue(id: $id) {
      relations(first: ${LIST_PAGE_SIZE}, after: $after) {
        nodes { id type relatedIssue { id identifier title team { id } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/** The rest of one issue's comments / history / link attachments, for the issue that has more than the first page holds. */
export const Q_ISSUE_COMMENTS = /* GraphQL */ `
  query LinearIssueComments($id: String!, $after: String) {
    issue(id: $id) {
      comments(first: ${LIST_PAGE_SIZE}, after: $after) {
        nodes { ${COMMENT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const Q_ISSUE_HISTORY = /* GraphQL */ `
  query LinearIssueHistory($id: String!, $after: String) {
    issue(id: $id) {
      history(first: 50, after: $after) {
        nodes { ${HISTORY_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const Q_ISSUE_LINKS = /* GraphQL */ `
  query LinearIssueLinks($id: String!, $after: String) {
    issue(id: $id) {
      attachments(first: ${LIST_PAGE_SIZE}, after: $after) {
        nodes { ${LINK_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
