/**
 * JWT payload — exact shape per Foundations Account-Session Decision.
 * Nothing else. No accountId, no workspaceId, no role — all resolved
 * fresh per-request, never cached in the token.
 */
export interface JwtPayload {
  sub: string; // userId
  email: string;
  iat?: number;
  exp?: number;
}

/**
 * What JwtStrategy.validate() returns and attaches to request.user.
 * Minimal identity ONLY — no nested fetch of preferences/organizations/
 * teams/members. Downstream context (account/workspace/role) is resolved
 * per-request by PermissionResolver, not pre-loaded here.
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
}
