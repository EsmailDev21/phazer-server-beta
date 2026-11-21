import { createHmac, timingSafeEqual } from 'crypto';

/**
 * GitHub webhook protocol (ADR-0014): signature check and a defensive reduction of a delivery to the few fields we use.
 * The reduced `GithubWork` is what travels through the queue: never the raw payload (a push event can be megabytes, and the
 * worker must not depend on fields nobody validated).
 */

export type SignatureVerdict = 'ok' | 'no-secret' | 'missing' | 'malformed' | 'mismatch';

/** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the RAW body>`. Fails closed without a (long enough) secret. Constant-time compare. */
export function verifyGithubSignature(i: { secret: string | undefined; signature: string | undefined; rawBody: Buffer | undefined }): SignatureVerdict {
  if (!i.secret || i.secret.length < 16) return 'no-secret';
  if (!i.signature || !i.rawBody) return 'missing';
  const m = /^sha256=([0-9a-f]{64})$/i.exec(i.signature.trim());
  if (!m) return 'malformed';
  const expected = createHmac('sha256', i.secret).update(i.rawBody).digest();
  const given = Buffer.from(m[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? 'ok' : 'mismatch';
}

/** Rotation overlap, same contract as Slack's (ADR-0015 d.5): the primary must be valid; `previous` is an additional accepted key. */
export function verifyGithubSignatureWithRotation(i: { secret: string | undefined; previousSecret?: string | undefined; signature: string | undefined; rawBody: Buffer | undefined }): SignatureVerdict {
  const primary = verifyGithubSignature({ secret: i.secret, signature: i.signature, rawBody: i.rawBody });
  if (primary !== 'mismatch' || !i.previousSecret) return primary;
  return verifyGithubSignature({ secret: i.previousSecret, signature: i.signature, rawBody: i.rawBody }) === 'ok' ? 'ok' : primary;
}

export interface GhRepo { id: number; fullName: string }
export interface GhSender { id: string; login: string }
interface Base { installationId: string }

export type GithubWork =
  | (Base & { kind: 'pr'; action: PrAction; repo: GhRepo; sender: GhSender | null; pr: { number: number; title: string; body: string; headRef: string; draft: boolean; merged: boolean; closed: boolean } })
  | (Base & { kind: 'issue'; action: IssueAction; repo: GhRepo; sender: GhSender | null; issue: { number: number; title: string; body: string; closed: boolean } })
  | (Base & { kind: 'push'; repo: GhRepo; sender: GhSender | null; branch: string; commits: Array<{ sha: string; message: string }> })
  | (Base & { kind: 'branch'; repo: GhRepo; sender: GhSender | null; branch: string })
  | (Base & { kind: 'installation'; action: 'deleted' | 'suspend' | 'unsuspend' })
  | (Base & { kind: 'installation_repos'; added: number[]; removed: number[] });

export type PrAction = 'opened' | 'reopened' | 'ready_for_review' | 'converted_to_draft' | 'closed' | 'edited';
export type IssueAction = 'opened' | 'reopened' | 'closed' | 'edited';
const PR_ACTIONS = new Set<string>(['opened', 'reopened', 'ready_for_review', 'converted_to_draft', 'closed', 'edited']);
const ISSUE_ACTIONS = new Set<string>(['opened', 'reopened', 'closed', 'edited']);

export const MAX_TITLE = 300;
export const MAX_BODY = 4000;
export const MAX_COMMIT_MESSAGE = 1000;
export const MAX_COMMITS = 20;
export const MAX_REPO_IDS = 100;
const FULL_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);

function installationOf(b: Json): string | null {
  const id = obj(b.installation)?.id;
  const n = posInt(typeof id === 'string' && /^\d{1,15}$/.test(id) ? Number(id) : id);
  return n ? String(n) : null;
}

function repoOf(b: Json): GhRepo | null {
  const r = obj(b.repository);
  const id = posInt(r?.id);
  const fullName = typeof r?.full_name === 'string' ? r.full_name : '';
  return id && FULL_NAME.test(fullName) ? { id, fullName } : null;
}

function senderOf(b: Json): GhSender | null {
  const s = obj(b.sender);
  const id = posInt(s?.id);
  return id ? { id: String(id), login: str(s?.login, 100) } : null;
}

/** The event names we react to; everything else is acknowledged and ignored BEFORE dedupe (so it never fills the dedupe table). */
export const HANDLED_EVENTS: ReadonlySet<string> = new Set(['pull_request', 'issues', 'push', 'create', 'installation', 'installation_repositories']);

/**
 * Null = nothing for us to do (unsupported event/action, malformed payload, tag push, branch deletion ...). Never throws:
 * the payload is signed by GitHub but is still treated as untrusted input.
 */
export function extractGithubWork(event: string, body: unknown): GithubWork | null {
  const b = obj(body);
  if (!b) return null;
  const installationId = installationOf(b);
  if (!installationId) return null;

  switch (event) {
    case 'installation': {
      const a = b.action;
      return a === 'deleted' || a === 'suspend' || a === 'unsuspend' ? { kind: 'installation', action: a, installationId } : null;
    }
    case 'installation_repositories': {
      const ids = (v: unknown) => (Array.isArray(v) ? v.slice(0, MAX_REPO_IDS).map((r) => posInt(obj(r)?.id)).filter((n): n is number => n !== null) : []);
      const added = ids(b.repositories_added);
      const removed = ids(b.repositories_removed);
      return added.length || removed.length ? { kind: 'installation_repos', installationId, added, removed } : null;
    }
    case 'pull_request': {
      const repo = repoOf(b);
      const pr = obj(b.pull_request);
      const number = posInt(pr?.number);
      if (!repo || !pr || !number || typeof b.action !== 'string' || !PR_ACTIONS.has(b.action)) return null;
      return {
        kind: 'pr', installationId, repo, sender: senderOf(b), action: b.action as PrAction,
        pr: { number, title: str(pr.title, MAX_TITLE), body: str(pr.body, MAX_BODY), headRef: str(obj(pr.head)?.ref, 250), draft: pr.draft === true, merged: pr.merged === true, closed: pr.state === 'closed' },
      };
    }
    case 'issues': {
      const repo = repoOf(b);
      const issue = obj(b.issue);
      const number = posInt(issue?.number);
      if (!repo || !issue || !number || typeof b.action !== 'string' || !ISSUE_ACTIONS.has(b.action) || issue.pull_request) return null;
      return {
        kind: 'issue', installationId, repo, sender: senderOf(b), action: b.action as IssueAction,
        issue: { number, title: str(issue.title, MAX_TITLE), body: str(issue.body, MAX_BODY), closed: issue.state === 'closed' },
      };
    }
    case 'create': {
      const repo = repoOf(b);
      const ref = str(b.ref, 250);
      return repo && b.ref_type === 'branch' && ref ? { kind: 'branch', installationId, repo, sender: senderOf(b), branch: ref } : null;
    }
    case 'push': {
      const repo = repoOf(b);
      const ref = typeof b.ref === 'string' ? b.ref : '';
      if (!repo || !ref.startsWith('refs/heads/') || b.deleted === true) return null;
      const commits = (Array.isArray(b.commits) ? b.commits : []).slice(0, MAX_COMMITS).flatMap((c) => {
        const o = obj(c);
        return o && typeof o.id === 'string' && SHA.test(o.id) ? [{ sha: o.id.toLowerCase(), message: str(o.message, MAX_COMMIT_MESSAGE) }] : [];
      });
      return { kind: 'push', installationId, repo, sender: senderOf(b), branch: ref.slice('refs/heads/'.length, 250 + 'refs/heads/'.length), commits };
    }
    default:
      return null;
  }
}
