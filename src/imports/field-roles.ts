import { FIELD_ROLES, FieldRole, FieldRoleChoice, SourceField } from './imports.types';

/**
 * Step 4.10 - "which column is the status?". Shared by every adapter that needs it (Monday, Notion), so the suggestion and the
 * resolution of a choice are the same everywhere and tested once.
 *
 *   discover():  suggestFieldRoles(fields)            -> each field with the roles it would get by default
 *   estimate() / fetchBundle():  resolveFieldRoles(node.fields, source.fieldRoles)  -> the field to read for each role
 */

type RawField = Omit<SourceField, 'suggested'>;

const NAME: Record<FieldRole, RegExp> = {
  status: /^(status|state|stage|workflow|progress)$/i,
  priority: /priorit|urgen|severity/i,
  assignee: /assign|owner|responsible|person|people|who/i,
  due: /due|deadline|target|end\s*date|finish/i,
  start: /start|begin|kick.?off/i,
};
/** Looser second pass for the status role only ("Task status", "Current stage"). */
const STATUS_LOOSE = /status|state|stage/i;

const can = (f: RawField, role: FieldRole): boolean => f.roles.includes(role);

/**
 * The default for every role, one field per role, a field never serving two roles. By NAME first; for status the first status-typed
 * field is the fallback (a board always has to have a workflow), for assignee / due the only candidate of the right type is a safe
 * fallback; priority and start are never guessed from type alone ("another status column" is often Priority, not a second workflow).
 */
export function suggestFieldRoles(fields: RawField[]): SourceField[] {
  const used = new Set<string>();
  const picked = new Map<string, FieldRole[]>();
  const take = (role: FieldRole, f: RawField | undefined): void => {
    if (!f || used.has(f.id)) return;
    used.add(f.id);
    picked.set(f.id, [...(picked.get(f.id) ?? []), role]);
  };
  const free = (role: FieldRole): RawField[] => fields.filter((f) => can(f, role) && !used.has(f.id));

  take('status', free('status').find((f) => NAME.status.test(f.name.trim())) ?? free('status').find((f) => STATUS_LOOSE.test(f.name)) ?? free('status')[0]);
  // priority before assignee/due: a "Priority" status column must not be spent on anything else
  take('priority', free('priority').find((f) => NAME.priority.test(f.name)));
  take('assignee', free('assignee').find((f) => NAME.assignee.test(f.name)) ?? (free('assignee').length === 1 ? free('assignee')[0] : undefined));
  take('due', free('due').find((f) => NAME.due.test(f.name)) ?? (free('due').length === 1 ? free('due')[0] : undefined));
  take('start', free('start').find((f) => NAME.start.test(f.name)));

  return fields.map((f) => (picked.has(f.id) ? { ...f, suggested: picked.get(f.id)! } : { ...f }));
}

export interface ResolvedRoles {
  /** The field to read for each role; a role with no entry is not mapped. */
  byRole: Partial<Record<FieldRole, SourceField>>;
  /** Roles filled by the suggestion (the person did not choose): the preview says so. */
  guessed: FieldRole[];
  /** Roles whose CHOSEN field no longer exists on the source (deleted since the person chose): the adapter must say so, not guess. */
  missing: Array<{ role: FieldRole; fieldId: string }>;
}

export function resolveFieldRoles(fields: SourceField[] | undefined, chosen?: FieldRoleChoice): ResolvedRoles {
  const list = fields ?? [];
  const byRole: ResolvedRoles['byRole'] = {};
  const guessed: FieldRole[] = [];
  const missing: ResolvedRoles['missing'] = [];
  // A field the person CHOSE for a role is spent: it is not also handed to another role by suggestion (the picker shows the same rule).
  const own = (role: FieldRole): boolean => !!chosen && Object.prototype.hasOwnProperty.call(chosen, role);
  const chosenIds = new Set(FIELD_ROLES.filter(own).map((r) => chosen![r]).filter((v): v is string => typeof v === 'string'));
  for (const role of FIELD_ROLES) {
    if (own(role)) {
      const id = chosen![role];
      if (id === null || id === undefined) continue; // explicitly none
      const f = list.find((x) => x.id === id);
      if (f && f.roles.includes(role)) byRole[role] = f;
      else missing.push({ role, fieldId: id });
    } else {
      const f = list.find((x) => x.suggested?.includes(role) && !chosenIds.has(x.id));
      if (f) {
        byRole[role] = f;
        guessed.push(role);
      }
    }
  }
  return { byRole, guessed, missing };
}

const ROLE_LABEL: Record<FieldRole, string> = { status: 'status', priority: 'priority', assignee: 'assignee', due: 'due date', start: 'start date' };

/** The preview line for a source whose roles were guessed; null when the person chose everything (or nothing was guessable). */
export function guessedRolesWarning(sourceName: string, r: ResolvedRoles): { code: string; message: string } | null {
  if (r.guessed.length === 0) return null;
  const parts = r.guessed.map((role) => `${ROLE_LABEL[role]}: "${r.byRole[role]!.name}"`);
  return { code: 'FIELD_ROLES_GUESSED', message: `${sourceName}: the fields were guessed (${parts.join(', ')}). Check them in the Select step if they are not right.` };
}

export function missingRolesWarning(sourceName: string, r: ResolvedRoles): { code: string; message: string } | null {
  if (r.missing.length === 0) return null;
  return { code: 'FIELD_ROLES_MISSING', message: `${sourceName}: ${r.missing.length} chosen field(s) no longer exist (${r.missing.map((m) => ROLE_LABEL[m.role]).join(', ')}); they are not mapped. Choose them again in the Select step.` };
}
