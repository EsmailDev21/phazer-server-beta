import type { Readable } from 'node:stream';
import { ConnectorAdapter } from '../integrations/core/integration.types';
import {
  ImportEstimate,
  ImportOptions,
  ImportSelection,
  SourceTree,
} from './imports.types';

/** What an import-capable adapter is handed on every call: a live token, never a stored credential. */
export interface ImportAdapterContext {
  connectionId: string;
  externalAccountId: string;
  /** Fresh from CredentialService.getAccessToken (refreshed under lock when near expiry). */
  accessToken: string;
}

/**
 * Step 4.1 slice of the IMPORT capability (diagram 02). A provider that imports implements this on top of
 * ConnectorAdapter (connect / refresh / revoke stay as in ADR-0009). Step 4.4 adds `fetchBundle`, step 4.6
 * `fetchAttachment`, each next to the code that calls it - same rule ADR-0009 d.2 set.
 *
 * Both methods must be READ-ONLY at the provider, and must go through ProviderHttpClient (rate limits,
 * Retry-After, circuit breaker). A throw of ProviderAuthRejectedError is handled by CredentialService;
 * ProviderRateLimitedError / transient errors surface to the caller as 503 here (preview) or as a PAUSE (executor).
 */
export interface ImportCapableAdapter extends ConnectorAdapter {
  /** The hierarchy the person picks from. */
  discover(ctx: ImportAdapterContext): Promise<SourceTree>;
  /** Dry run for a selection: counts only, nothing is written anywhere. */
  estimate(
    ctx: ImportAdapterContext,
    selection: ImportSelection,
    options: ImportOptions,
  ): Promise<ImportEstimate>;
  /**
   * One page of the selection as a CanonicalBundle (step 4.4). Called repeatedly by the executor with the cursor the previous
   * call returned (null the first time) until `next` is null. READ-ONLY at the provider; through ProviderHttpClient.
   *
   * Contract:
   *  - The FIRST page carries the structure (projects with their statuses, issue types, custom fields, iterations, tags, users);
   *    task pages follow. A task whose project / parent / dependency partner is not imported yet is handled (deferred), but a
   *    task whose PROJECT never arrives is reported and skipped.
   *  - Pages are bounded by CANONICAL_LIMITS (1000 tasks, 5000 dependencies ...); the adapter picks the size.
   *  - `next` must be plain JSON (it is stored in the job's checkpoint) and must make a re-fetch of the SAME page possible: the
   *    executor may call again with a cursor it already used (at-least-once).
   *  - The page is NOT trusted: the executor validates it (validateBundle) before anything else.
   *  - Throw ProviderRateLimitedError / ProviderHttpError / ProviderAuthRejectedError as ProviderHttpClient does; the executor
   *    turns them into pause / retry (classifyImportError).
   */
  fetchBundle(input: FetchBundleInput): Promise<FetchBundleResult>;
  /**
   * Step 4.6. Opens ONE file for the attachment-copy phase. `providerRef` is the opaque string the adapter itself put on a
   * CanonicalAttachment; nothing else may ever be passed here, and the adapter must refuse a ref that does not point at the
   * provider's own file host (the ref originates from provider-controlled text, so it is an SSRF vector if trusted blindly).
   * READ-ONLY at the provider, through ProviderHttpClient.openStream (same rate limit / breaker as every other call).
   * An adapter that has no files simply omits it; the executor then reports the files it was told about as not copied.
   * Throw the ProviderHttpClient error classes: 401 -> the job pauses, 429 / 5xx -> delayed retry, any other 4xx -> THIS file
   * is reported and skipped.
   */
  fetchAttachment?(input: FetchAttachmentInput): Promise<FetchedAttachment>;

  /**
   * Step 4.7b. The type of the source's top-level container that is a workspace in its own right (ClickUp: 'space'). When set,
   * `ImportsService.createPerSpace` can create / reuse one of OUR workspaces per such container, with one import job each. Absent
   * = the provider has no such level (Linear: the organization IS the connection, a team is one of our projects).
   */
  readonly workspaceNodeType?: string;
}

export interface FetchAttachmentInput {
  ctx: ImportAdapterContext;
  providerRef: string;
}

export interface FetchedAttachment {
  /** The bytes. The caller consumes it or destroys it; the adapter never buffers it whole. */
  stream: Readable;
  /** From Content-Length when the provider sends it. */
  sizeBytes?: number;
  /** From Content-Type when the provider sends it. */
  mimeType?: string;
}

export interface FetchBundleInput {
  ctx: ImportAdapterContext;
  selection: ImportSelection;
  options: ImportOptions;
  /** null = start. Otherwise exactly what a previous call returned as `next`. */
  cursor: unknown;
}

export interface FetchBundleResult {
  /** A CanonicalBundle page (unvalidated). */
  bundle: unknown;
  /** Continue here, or null when the source is exhausted. */
  next: unknown | null;
}

export function isImportCapable(a: ConnectorAdapter): a is ImportCapableAdapter {
  const c = a as Partial<ImportCapableAdapter>;
  return (
    a.capabilities.has('IMPORT') &&
    typeof c.discover === 'function' &&
    typeof c.estimate === 'function'
  );
}
