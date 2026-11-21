/**
 * Step 3.8. The operations an editor can send to change a template draft. A batch of ops is
 * applied atomically to a copy of the blueprint; the result is only kept when the WHOLE blueprint
 * validates afterwards, so a draft is always a valid blueprint.
 *
 * Identity rules (the reason this API exists instead of "PUT the whole blueprint"):
 *  - an existing node's nodeKey NEVER changes: rename, update, move and reorder keep it;
 *  - a new node gets `n<seq>` from a per-template counter that never goes back, so a key is never
 *    reused for something else, not even after the node was deleted or a draft was discarded.
 *  - `ref` gives a new node (project, task, iteration, asset) a temporary alias (`$a`) that later ops in
 *    the SAME batch can use wherever a key goes, including a task's `iteration` and `attachments`.
 */
export type EditableCollection = 'variables' | 'roles' | 'modules' | 'tags' | 'customFields' | 'issueTypes' | 'iterations';
export type RenameableCollection = 'tags' | 'issueTypes' | 'roles' | 'customFields';

export type Obj = Record<string, unknown>;

export type EditOp =
  | { op: 'setMeta'; set: Obj }
  /** Puts a whole earlier blueprint back (the editor's undo and redo). Validated like any other result; the kind cannot change. */
  | { op: 'replaceBlueprint'; blueprint: Obj }
  | { op: 'setDateAnchor'; value: Obj | null }
  | { op: 'setWorkspace'; set: Obj }
  | { op: 'upsert'; ref?: string; collection: EditableCollection; item: Obj; index?: number }
  | { op: 'remove'; collection: EditableCollection; key: string }
  | { op: 'rename'; collection: RenameableCollection; from: string; to: string }
  | { op: 'reorder'; collection: EditableCollection; keys: string[] }
  | { op: 'addProject'; ref?: string; project: Obj; index?: number }
  | { op: 'updateProject'; nodeKey: string; set: Obj }
  | { op: 'moveProject'; nodeKey: string; index: number }
  | { op: 'removeProject'; nodeKey: string }
  | { op: 'addTask'; ref?: string; project?: string; parent?: string; index?: number; task: Obj }
  | { op: 'updateTask'; nodeKey: string; set?: Obj; unset?: string[] }
  | { op: 'moveTask'; nodeKey: string; project?: string; parent?: string | null; index?: number; clear?: Array<'status' | 'iteration'> }
  | { op: 'duplicateTask'; ref?: string; nodeKey: string }
  | { op: 'removeTask'; nodeKey: string }
  | { op: 'addDependency'; from: string; to: string; type?: string }
  | { op: 'removeDependency'; from: string; to: string; type?: string }
  | { op: 'addAsset'; ref?: string; sha256: string }
  | { op: 'removeAsset'; key: string };

/** A file the template store holds (see TemplateAsset); `addAsset` can only name one of these. */
export interface StoredAssetInfo { sha256: string; fileName: string; mimeType: string; sizeBytes: number }

export const MAX_OPS_PER_REQUEST = 200;

export interface OpError { index: number; op: string; code: string; message: string }

export type ApplyOpsResult =
  | {
      ok: true;
      blueprint: unknown; // the validated, normalised blueprint
      /** ref -> the nodeKey it became */
      created: Record<string, string>;
      /** every key minted by this batch, in order */
      minted: string[];
      /** the counter to store: the next number NOT yet used */
      nextSeq: number;
      /** things removed or changed as a side effect of an op (dependencies of a deleted task...) */
      cascaded: Array<{ index: number; note: string }>;
    }
  | { ok: false; kind: 'op'; error: OpError }
  | { ok: false; kind: 'invalid'; issues: unknown[]; truncated: boolean };
