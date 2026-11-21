/**
 * Raw monday.com GraphQL shapes, as far as the importer reads them. Written from monday's public documentation (developer.monday.com:
 * OAuth, rate limits, API versioning, boards / items / items_page / updates / assets / column types) and third-party clients (ADR-0041):
 * every field is optional because none of it was checked against a live account. Ids are numeric but ALWAYS handled as strings.
 */
export interface MnError {
  message?: string;
  extensions?: { code?: string; status_code?: number; retry_in_seconds?: number; error_data?: unknown };
}

export interface MnEnvelope<T> {
  data?: (T & { complexity?: MnComplexity | null }) | null;
  errors?: MnError[];
}

/** `complexity { query before after reset_in_x_seconds }`: asked for on every call (free) to pace ourselves. */
export interface MnComplexity {
  query?: number | null;
  before?: number | null;
  after?: number | null;
  reset_in_x_seconds?: number | null;
}

export interface MnUser {
  id: string | number;
  name?: string | null;
  email?: string | null;
  is_guest?: boolean | null;
  enabled?: boolean | null;
}

export interface MnWorkspace {
  /** The "main workspace" has no id in some answers. */
  id?: string | number | null;
  name?: string | null;
  state?: string | null;
}

export interface MnColumn {
  id: string;
  title?: string | null;
  /** status | people | date | timeline | dropdown | numbers | text | long_text | link | email | phone | checkbox | dependency | subtasks | file | ... */
  type?: string | null;
  archived?: boolean | null;
  settings_str?: string | null;
}

export interface MnGroup {
  id: string;
  title?: string | null;
  archived?: boolean | null;
  position?: string | null;
}

export interface MnBoard {
  id: string | number;
  name?: string | null;
  /** board | sub_items_board | document ... : only `board` is a project. */
  type?: string | null;
  state?: string | null;
  workspace_id?: string | number | null;
  url?: string | null;
  description?: string | null;
  items_count?: number | null;
  columns?: MnColumn[] | null;
  groups?: MnGroup[] | null;
}

/** The ColumnValue interface: id, type, text, value (a JSON STRING whose shape depends on the type). */
export interface MnColumnValue {
  id: string;
  type?: string | null;
  text?: string | null;
  value?: string | null;
}

export interface MnSubitem {
  id: string | number;
  name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  creator?: { id: string | number } | null;
  column_values?: MnColumnValue[] | null;
}

export interface MnItem extends MnSubitem {
  state?: string | null;
  url?: string | null;
  group?: { id: string; title?: string | null } | null;
  subitems?: MnSubitem[] | null;
}

export interface MnAsset {
  id: string | number;
  name?: string | null;
  file_extension?: string | null;
  file_size?: number | null;
  public_url?: string | null;
  created_at?: string | null;
  uploaded_by?: { id: string | number } | null;
}

export interface MnReply {
  id: string | number;
  body?: string | null;
  text_body?: string | null;
  created_at?: string | null;
  creator_id?: string | number | null;
  creator?: { id: string | number; name?: string | null } | null;
}

export interface MnUpdate extends MnReply {
  replies?: MnReply[] | null;
  assets?: MnAsset[] | null;
}

/** `items(ids: [...]) { id assets updates }`: what comes with the page, in one call for up to 100 items. */
export interface MnItemExtras {
  id: string | number;
  assets?: MnAsset[] | null;
  updates?: MnUpdate[] | null;
}
