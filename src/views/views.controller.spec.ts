import 'reflect-metadata';
import { REQUIRE_ACCESS_KEY } from '../access-control/decorators/require-access.decorator';
import { REQUIRE_FEATURE_KEY } from '../feature-flags/require-feature.decorator';
import { ViewsController } from './views.controller';

const proto = ViewsController.prototype as unknown as Record<
  string,
  () => void
>;
const access = (name: string) =>
  Reflect.getMetadata(REQUIRE_ACCESS_KEY, proto[name]);

describe('ViewsController guards (step 5.4)', () => {
  it('is hidden (404) while FEATURE_WORKFLOW is off', () => {
    expect(Reflect.getMetadata(REQUIRE_FEATURE_KEY, ViewsController)).toEqual([
      'WORKFLOW',
    ]);
  });
  it.each(['create', 'update', 'remove', 'validate', 'duplicate', 'runConfig'])(
    '%s needs manageSavedViews on the workspace',
    (name) => {
      expect(access(name)).toMatchObject({
        action: 'manageSavedViews',
        targetType: 'WORKSPACE',
      });
    },
  );
  it.each(['list', 'get', 'tasks'])(
    '%s is a read (service-level workspace access)',
    (name) => {
      expect(access(name)).toBeUndefined();
    },
  );
  it('every route is accounted for (a new one must be classified here)', () => {
    expect(
      Object.getOwnPropertyNames(proto)
        .filter((n) => n !== 'constructor')
        .sort(),
    ).toEqual([
      'create',
      'duplicate',
      'get',
      'list',
      'remove',
      'runConfig',
      'tasks',
      'update',
      'validate',
    ]);
  });
});
