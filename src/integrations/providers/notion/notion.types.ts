/**
 * Raw Notion API shapes (version 2026-03-11), as far as the importer reads them. Written from Notion's public documentation
 * (developers.notion.com: authorization, create-a-token, upgrade guides 2025-09-03 and 2026-03-11, data sources, property schema / values,
 * retrieve page markdown, search, request limits) and third-party clients (ADR-0042). Every field is optional because none of it was checked
 * against a live workspace. Ids are dashed UUID strings.
 */
export interface NtList<T> {
  object?: string;
  results: T[];
  has_more?: boolean | null;
  next_cursor?: string | null;
}

export interface NtError {
  object?: 'error';
  status?: number;
  code?: string;
  message?: string;
}

export interface NtRichText {
  type?: string;
  plain_text?: string | null;
  href?: string | null;
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; code?: boolean } | null;
  text?: { content?: string; link?: { url?: string } | null } | null;
  mention?: { type?: string; user?: { id?: string } | null; page?: { id?: string } | null } | null;
}

export interface NtUser {
  object?: 'user';
  id: string;
  /** person | bot */
  type?: string;
  name?: string | null;
  person?: { email?: string | null } | null;
}

export interface NtOption {
  id?: string;
  name?: string | null;
  color?: string | null;
}

export interface NtStatusGroup {
  id?: string;
  /** "To-do" | "In progress" | "Complete" */
  name?: string | null;
  option_ids?: string[] | null;
}

/** One column of a data source. */
export interface NtPropertySchema {
  id: string;
  name?: string | null;
  /** title | rich_text | number | select | multi_select | status | date | people | files | checkbox | url | email | phone_number | formula | relation | rollup | unique_id | created_time ... */
  type?: string | null;
  select?: { options?: NtOption[] | null } | null;
  multi_select?: { options?: NtOption[] | null } | null;
  status?: { options?: NtOption[] | null; groups?: NtStatusGroup[] | null } | null;
  relation?: { data_source_id?: string | null; database_id?: string | null } | null;
}

export interface NtDataSource {
  object?: 'data_source';
  id: string;
  title?: NtRichText[] | null;
  properties?: Record<string, NtPropertySchema> | null;
  parent?: { type?: string; database_id?: string | null } | null;
  in_trash?: boolean | null;
  archived?: boolean | null;
}

export interface NtFileItem {
  name?: string | null;
  /** file (hosted by Notion, a signed URL that expires) | external (a link) */
  type?: string | null;
  file?: { url?: string | null; expiry_time?: string | null } | null;
  external?: { url?: string | null } | null;
}

/** A property VALUE on a page. */
export interface NtPropertyValue {
  id: string;
  type?: string | null;
  title?: NtRichText[] | null;
  rich_text?: NtRichText[] | null;
  number?: number | null;
  select?: NtOption | null;
  multi_select?: NtOption[] | null;
  status?: NtOption | null;
  date?: { start?: string | null; end?: string | null; time_zone?: string | null } | null;
  people?: NtUser[] | null;
  files?: NtFileItem[] | null;
  checkbox?: boolean | null;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  relation?: Array<{ id: string }> | null;
  unique_id?: { prefix?: string | null; number?: number | null } | null;
  has_more?: boolean | null;
}

export interface NtPage {
  object?: 'page';
  id: string;
  created_time?: string | null;
  last_edited_time?: string | null;
  created_by?: { id?: string } | null;
  in_trash?: boolean | null;
  archived?: boolean | null;
  url?: string | null;
  properties?: Record<string, NtPropertyValue> | null;
}

export interface NtComment {
  id: string;
  discussion_id?: string | null;
  created_time?: string | null;
  created_by?: { id?: string } | null;
  rich_text?: NtRichText[] | null;
}

export interface NtMarkdown {
  object?: 'page_markdown';
  id?: string;
  markdown?: string | null;
  truncated?: boolean | null;
  unknown_block_ids?: string[] | null;
}

export interface NtTokenResponse {
  access_token?: string;
  token_type?: string;
  refresh_token?: string | null;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string | null;
  error?: string;
  code?: string;
  message?: string;
}
