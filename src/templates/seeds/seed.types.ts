/** A reference file shipped with a seed. Its bytes are stored by the seeder; the blueprint's `assets` entry is derived from them. */
export interface SeedFile {
  /** the key tasks use in `attachments: [key]` */
  key: string;
  fileName: string;
  mimeType: string;
  text: string;
}

export interface SeedDefinition {
  /** Stable identity (^[a-z][a-z0-9-]{1,63}$). Never rename: it is how a re-run finds the template it already published. */
  seedKey: string;
  /** Without `assets`; those are derived from `files`. name / description / category come from `meta`. */
  blueprint: Record<string, unknown>;
  files?: SeedFile[];
  tags: string[];
  /** Shown on the version this definition publishes when it CHANGES an existing seed ("what is new"). */
  changelog: string;
  /** Shown on version 1.0.0 when the seed is created from scratch. Default: "First release." */
  initialChangelog?: string;
  /** How a CHANGED definition bumps the version (default minor). Ignored for the first one (1.0.0). */
  bump?: 'major' | 'minor' | 'patch';
}

export type SeedAction = 'created' | 'versioned' | 'unchanged';

export interface SeedResult {
  seedKey: string;
  templateId: string;
  action: SeedAction;
  semver: string;
  checksum: string;
  /** true when the name / description / category / tags / visibility of the envelope had to be re-synced */
  metaUpdated: boolean;
}

export interface SeedReport {
  systemAccountId: string;
  systemAccountCreated: boolean;
  results: SeedResult[];
}
