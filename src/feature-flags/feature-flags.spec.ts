import {
  FLAGS_REQUIRING_REDIS,
  parseFeatureFlags,
  validateFeatureEnv,
} from './feature-flags';
import { FeatureFlagsService } from './feature-flags.service';

const ALL_OFF = {
  WORKFLOW: false,
  INTEGRATIONS: false,
  IMPORTS: false,
  TEMPLATES: false,
  MARKETPLACE: false,
};

describe('parseFeatureFlags', () => {
  it('treats an empty environment as everything off', () => {
    expect(parseFeatureFlags({}).flags).toEqual(ALL_OFF);
  });

  it.each(['true', 'TRUE', 'True', '1', ' true ', '\t1\n'])(
    '%j turns a flag on',
    (value) => {
      expect(
        parseFeatureFlags({ FEATURE_WORKFLOW: value }).flags.WORKFLOW,
      ).toBe(true);
    },
  );

  it.each(['false', 'FALSE', '0', '', '  '])(
    '%j is off and not ambiguous',
    (value) => {
      const parsed = parseFeatureFlags({ FEATURE_WORKFLOW: value });
      expect(parsed.flags.WORKFLOW).toBe(false);
      expect(parsed.ambiguous).toEqual([]);
    },
  );

  it.each(['yes', 'on', 'enabled', 'y', '2', 'tru'])(
    '%j is OFF but reported as ambiguous, so nobody thinks it is on',
    (value) => {
      const parsed = parseFeatureFlags({ FEATURE_IMPORTS: value });
      expect(parsed.flags.IMPORTS).toBe(false);
      expect(parsed.ambiguous).toEqual([{ name: 'FEATURE_IMPORTS', value }]);
    },
  );

  it('reports unknown FEATURE_* variables (typo guard) and ignores unrelated ones', () => {
    const parsed = parseFeatureFlags({
      FEATURE_WORKFLOWS: 'true', // typo
      FEATURE_NOPE: '1',
      FEATUREWORKFLOW: 'true', // no underscore: not ours
      SOMETHING_ELSE: 'true',
    });
    expect(parsed.unknown).toEqual(['FEATURE_NOPE', 'FEATURE_WORKFLOWS']);
    expect(parsed.flags).toEqual(ALL_OFF);
  });

  it('flags are independent', () => {
    const { flags } = parseFeatureFlags({
      FEATURE_TEMPLATES: 'true',
      FEATURE_IMPORTS: 'false',
    });
    expect(flags).toEqual({ ...ALL_OFF, TEMPLATES: true });
  });
});

describe('validateFeatureEnv', () => {
  it('every existing environment keeps booting: all flags off needs nothing', () => {
    const report = validateFeatureEnv({});
    expect(report.problems).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('flags that need nothing extra never require Redis', () => {
    for (const name of ['WORKFLOW', 'TEMPLATES']) {
      const env: NodeJS.ProcessEnv = { [`FEATURE_${name}`]: 'true' };
      expect(validateFeatureEnv(env).problems).toEqual([]);
    }
  });

  it.each(FLAGS_REQUIRING_REDIS)(
    'FEATURE_%s without REDIS_URL is a boot problem',
    (flag) => {
      const report = validateFeatureEnv({ [`FEATURE_${flag}`]: 'true' });
      expect(report.problems).toHaveLength(1);
      expect(report.problems[0]).toContain('REDIS_URL is not set');
      expect(report.problems[0]).toContain(`FEATURE_${flag}`);
    },
  );

  it('rejects a blank or malformed REDIS_URL when a Redis flag is on', () => {
    const on = { FEATURE_IMPORTS: 'true' };
    expect(
      validateFeatureEnv({ ...on, REDIS_URL: '  ' }).problems[0],
    ).toContain('is not set');
    expect(
      validateFeatureEnv({ ...on, REDIS_URL: 'not a url' }).problems[0],
    ).toContain('not a valid URL');
    expect(
      validateFeatureEnv({ ...on, REDIS_URL: 'http://localhost:6379' })
        .problems[0],
    ).toContain('redis:// or rediss://');
  });

  it.each(['redis://localhost:6379', 'rediss://:pw@host.example:6380/2'])(
    'accepts REDIS_URL %s',
    (REDIS_URL) => {
      expect(
        validateFeatureEnv({ FEATURE_INTEGRATIONS: 'true', REDIS_URL })
          .problems,
      ).toEqual([]);
    },
  );

  it('names every Redis flag that is on, in one problem', () => {
    const { problems } = validateFeatureEnv({
      FEATURE_INTEGRATIONS: 'true',
      FEATURE_IMPORTS: '1',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('FEATURE_INTEGRATIONS / FEATURE_IMPORTS');
  });

  it('MARKETPLACE requires TEMPLATES', () => {
    expect(
      validateFeatureEnv({ FEATURE_MARKETPLACE: 'true' }).problems,
    ).toEqual([
      'FEATURE_MARKETPLACE is on but requires FEATURE_TEMPLATES to be on too.',
    ]);
    expect(
      validateFeatureEnv({
        FEATURE_MARKETPLACE: 'true',
        FEATURE_TEMPLATES: 'true',
      }).problems,
    ).toEqual([]);
  });

  it('a flag that is off never triggers its prerequisites', () => {
    expect(
      validateFeatureEnv({ FEATURE_MARKETPLACE: 'false' }).problems,
    ).toEqual([]);
  });

  it('collects several problems at once instead of failing on the first', () => {
    const { problems } = validateFeatureEnv({
      FEATURE_MARKETPLACE: 'true',
      FEATURE_IMPORTS: 'true',
    });
    expect(problems).toHaveLength(2);
  });

  it('surfaces warnings without making them problems', () => {
    const report = validateFeatureEnv({
      FEATURE_WORKFLOW: 'yes',
      FEATURE_TYPO: 'true',
    });
    expect(report.problems).toEqual([]);
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings.join('\n')).toContain('treated as OFF');
    expect(report.warnings.join('\n')).toContain('FEATURE_TYPO');
  });
});

describe('FeatureFlagsService', () => {
  it('answers from the env it was built with', () => {
    const svc = new FeatureFlagsService({
      FEATURE_WORKFLOW: 'true',
      FEATURE_TEMPLATES: '1',
    });
    expect(svc.isEnabled('WORKFLOW')).toBe(true);
    expect(svc.isEnabled('TEMPLATES')).toBe(true);
    expect(svc.isEnabled('IMPORTS')).toBe(false);
    expect(svc.enabledFlags()).toEqual(['WORKFLOW', 'TEMPLATES']);
  });

  it('reads the env once: later changes to the env object do not leak in', () => {
    const env: NodeJS.ProcessEnv = { FEATURE_WORKFLOW: 'true' };
    const svc = new FeatureFlagsService(env);
    env.FEATURE_WORKFLOW = 'false';
    env.FEATURE_IMPORTS = 'true';
    expect(svc.isEnabled('WORKFLOW')).toBe(true);
    expect(svc.isEnabled('IMPORTS')).toBe(false);
  });

  it('accepts the reserved per-account scope without changing the answer today', () => {
    const svc = new FeatureFlagsService({ FEATURE_WORKFLOW: 'true' });
    expect(svc.isEnabled('WORKFLOW', { accountId: 'acc_1' })).toBe(true);
    expect(svc.isEnabled('IMPORTS', { accountId: 'acc_1' })).toBe(false);
  });
});
