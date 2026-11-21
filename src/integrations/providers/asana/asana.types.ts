/**
 * Raw Asana API 1.0 shapes, as far as the importer reads them. Written from Asana's public documentation (developers.asana.com:
 * OAuth, scopes, pagination, rate limits, attachments, input/output options) and third-party typed clients (see ADR-0039): every field
 * is optional because none of it was checked against a live workspace. Ids are `gid` STRINGS everywhere; datetimes are ISO-8601
 * strings, dates are `YYYY-MM-DD`. Every response is `{ data, next_page? }`.
 */
export interface AsEnvelope<T> {
  data: T;
  next_page?: { offset?: string; path?: string; uri?: string } | null;
}

export interface AsRef {
  gid: string;
  name?: string | null;
  resource_type?: string;
}

export interface AsUser {
  gid: string;
  name?: string | null;
  email?: string | null;
  photo?: { image_128x128?: string | null } | null;
}

export interface AsWorkspace {
  gid: string;
  name?: string | null;
  is_organization?: boolean;
}

export interface AsProject {
  gid: string;
  name?: string | null;
  archived?: boolean | null;
  notes?: string | null;
  permalink_url?: string | null;
  created_at?: string | null;
  team?: AsRef | null;
  workspace?: AsRef | null;
}

export interface AsSection {
  gid: string;
  name?: string | null;
}

export interface AsEnumOption {
  gid: string;
  name?: string | null;
  enabled?: boolean | null;
}

/** Definition AND (on a task) value, as Asana returns them together. `resource_subtype`: text | enum | multi_enum | number | date | people | ... */
export interface AsCustomField {
  gid: string;
  name?: string | null;
  resource_subtype?: string | null;
  type?: string | null;
  is_formula_field?: boolean | null;
  enum_options?: AsEnumOption[] | null;
  // values (only on a task)
  text_value?: string | null;
  number_value?: number | null;
  enum_value?: { gid?: string; name?: string | null } | null;
  multi_enum_values?: Array<{ gid?: string; name?: string | null }> | null;
  date_value?: { date?: string | null; date_time?: string | null } | null;
  people_value?: Array<{ gid: string }> | null;
}

export interface AsCustomFieldSetting {
  gid?: string;
  custom_field?: AsCustomField | null;
}

export interface AsTag {
  gid?: string;
  name?: string | null;
  color?: string | null;
}

export interface AsMembership {
  project?: AsRef | null;
  section?: AsRef | null;
}

export interface AsTask {
  gid: string;
  name?: string | null;
  /** default_task | milestone | approval */
  resource_subtype?: string | null;
  completed?: boolean | null;
  completed_at?: string | null;
  created_at?: string | null;
  modified_at?: string | null;
  due_on?: string | null;
  due_at?: string | null;
  start_on?: string | null;
  start_at?: string | null;
  notes?: string | null;
  html_notes?: string | null;
  permalink_url?: string | null;
  assignee?: AsRef | null;
  created_by?: AsRef | null;
  parent?: AsRef | null;
  num_subtasks?: number | null;
  tags?: AsTag[] | null;
  memberships?: AsMembership[] | null;
  /** The tasks THIS task depends on (its blockers). */
  dependencies?: AsRef[] | null;
  custom_fields?: AsCustomField[] | null;
}

export interface AsStory {
  gid: string;
  /** 'comment' | 'system' */
  type?: string | null;
  /** 'comment_added' for a comment; system events have other values. */
  resource_subtype?: string | null;
  text?: string | null;
  html_text?: string | null;
  created_at?: string | null;
  created_by?: AsRef | null;
}

export interface AsAttachment {
  gid: string;
  name?: string | null;
  /** The hosting service: asana | dropbox | gdrive | onedrive | box | vimeo | external (docs name it both `host` and `resource_subtype`). */
  host?: string | null;
  resource_subtype?: string | null;
  size?: number | null;
  created_at?: string | null;
  download_url?: string | null;
  permanent_url?: string | null;
}
