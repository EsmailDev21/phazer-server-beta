import { SetMetadata } from '@nestjs/common';
import { ActionName, TargetType } from '../interfaces/access-control.types';
import { ACTION_CONFIG } from '../config/action-config';

export const REQUIRE_ACCESS_KEY = 'requireAccess';

/**
 * Applies AccessControlGuard's check for `action`. The guard auto-resolves
 * targetId from the route's :id param by default; pass an explicit param
 * name if the resource id lives elsewhere (e.g. a `workspaceId` query
 * param on a list/create route with no existing resource id yet).
 *
 * targetType is required whenever the action's ACTION_CONFIG has more than
 * one valid scope (e.g. uploadFile: TASK|PROJECT|COMMENT) since the guard
 * can't infer which one a given route means. For single-scope actions it
 * defaults to that one scope.
 */
export interface RequireAccessOptions {
  targetType?: TargetType;
  paramSource?: 'param' | 'query' | 'body';
  paramName?: string;
}

export const RequireAccess = (
  action: ActionName,
  options?: RequireAccessOptions,
) => {
  const config = ACTION_CONFIG[action];
  const targetType =
    options?.targetType ??
    (config?.scopes.length === 1 ? config.scopes[0] : undefined);

  if (!targetType) {
    throw new Error(
      `@RequireAccess("${action}"): targetType must be specified explicitly — this action has multiple valid scopes (${config?.scopes.join(', ')})`,
    );
  }

  return SetMetadata(REQUIRE_ACCESS_KEY, {
    action,
    targetType,
    paramSource: options?.paramSource ?? 'param',
    paramName: options?.paramName ?? 'id',
  });
};
