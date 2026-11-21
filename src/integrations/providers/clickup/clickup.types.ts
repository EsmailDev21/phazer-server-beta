/**
 * Raw ClickUp API v2 shapes, as far as the importer reads them. Written from ClickUp's public documentation and third-party
 * typed clients (see ADR-0036): every field is optional because none of it was checked against a live workspace. IDs arrive as
 * strings (tasks, lists) or numbers (users); timestamps as epoch-millisecond STRINGS.
 */
export interface CuUser {
  id: number | string;
  username?: string | null;
  email?: string | null;
  profilePicture?: string | null;
}

export interface CuStatus {
  id?: string;
  status: string;
  /** 'open' | 'custom' | 'done' | 'closed' */
  type?: string | null;
  color?: string | null;
  orderindex?: number | null;
}

export interface CuTag {
  name: string;
  tag_bg?: string | null;
}

export interface CuFieldOption {
  id?: string;
  name?: string | null;
  label?: string | null;
  orderindex?: number | null;
}

export interface CuCustomField {
  id: string;
  name?: string | null;
  type?: string | null;
  type_config?: { options?: CuFieldOption[] } | null;
  /** Shape depends on `type`; absent = not set. */
  value?: unknown;
}

export interface CuAttachment {
  id: string;
  title?: string | null;
  url?: string | null;
  size?: number | string | null;
  extension?: string | null;
  mimetype?: string | null;
  date?: string | number | null;
  user?: CuUser | null;
}

export interface CuTask {
  id: string;
  custom_id?: string | null;
  name?: string | null;
  description?: string | null;
  text_content?: string | null;
  markdown_description?: string | null;
  status?: CuStatus | null;
  priority?: { id?: string; priority?: string | null } | null;
  tags?: CuTag[] | null;
  assignees?: CuUser[] | null;
  creator?: CuUser | null;
  url?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  points?: number | null;
  archived?: boolean | null;
  parent?: string | null;
  custom_item_id?: number | null;
  /** [{ task_id, depends_on, ... }]: `task_id` waits for `depends_on`. */
  dependencies?: Array<{ task_id?: string; depends_on?: string }> | null;
  linked_tasks?: Array<{ task_id?: string; link_id?: string }> | null;
  custom_fields?: CuCustomField[] | null;
  attachments?: CuAttachment[] | null;
}

export interface CuComment {
  id: string | number;
  comment_text?: string | null;
  user?: CuUser | null;
  date?: string | number | null;
  reply_count?: number | string | null;
}

export interface CuList {
  id: string;
  name?: string | null;
  content?: string | null;
  archived?: boolean | null;
  statuses?: CuStatus[] | null;
  folder?: { id?: string; name?: string | null; hidden?: boolean } | null;
  space?: { id?: string } | null;
}

export interface CuFolder {
  id: string;
  name?: string | null;
  archived?: boolean | null;
  lists?: CuList[] | null;
}

export interface CuSpace {
  id: string;
  name?: string | null;
  archived?: boolean | null;
}

export interface CuTeam {
  id: string;
  name?: string | null;
  members?: Array<{ user: CuUser }> | null;
}
