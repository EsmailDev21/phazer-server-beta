import 'reflect-metadata';
import { REQUIRE_ACCESS_KEY } from '../access-control/decorators/require-access.decorator';
import { REQUIRE_FEATURE_KEY } from '../feature-flags/require-feature.decorator';
import { AutomationsController } from './automations.controller';

const proto = AutomationsController.prototype as unknown as Record<
  string,
  () => void
>;
const access = (name: string) =>
  Reflect.getMetadata(REQUIRE_ACCESS_KEY, proto[name]);

describe('AutomationsController guards (step 5.1)', () => {
  it('is hidden (404) while FEATURE_WORKFLOW is off', () => {
    expect(
      Reflect.getMetadata(REQUIRE_FEATURE_KEY, AutomationsController),
    ).toEqual(['WORKFLOW']);
  });

  it.each([
    'create',
    'update',
    'remove',
    'validate',
    'catalogue',
    'waits',
    'cancelWait',
  ])('%s needs manageAutomations on the workspace', (name) => {
    expect(access(name)).toMatchObject({
      action: 'manageAutomations',
      targetType: 'WORKSPACE',
    });
  });

  it.each(['list', 'get', 'runs'])(
    '%s is a read (service-level workspace access, no admin guard)',
    (name) => {
      expect(access(name)).toBeUndefined();
    },
  );

  it('every route is accounted for (a new one must be classified here)', () => {
    const routes = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor',
    );
    expect(routes.sort()).toEqual([
      'cancelWait',
      'catalogue',
      'create',
      'get',
      'list',
      'remove',
      'runs',
      'update',
      'validate',
      'waits',
    ]);
  });

  it('declares the catalogue route before `get`, or ":automationId" would swallow "catalogue"', () => {
    const routes = Object.getOwnPropertyNames(proto);
    expect(routes.indexOf('catalogue')).toBeGreaterThan(-1);
    expect(routes.indexOf('catalogue')).toBeLessThan(routes.indexOf('get'));
  });
});
