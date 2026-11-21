import { Exclude } from 'class-transformer';
import { PlatformRole, User } from '@prisma/client';

/**
 * Foundations Validation Policy — RULE 4 (structural safety net):
 * global ClassSerializerInterceptor + @Exclude() on User.password (and any
 * other field that must never leave the server) — not reliance on developer
 * memory alone.
 *
 * Fixes: the ~80-site password-hash leak, the single most severe finding
 * in the whole audit.
 *
 * Any controller returning a Prisma User row MUST wrap it in this class
 * (or spread into `new UserEntity({...})`) so ClassSerializerInterceptor
 * strips the excluded fields regardless of what the service selected.
 */
export class UserEntity implements User {
  id: string;
  email: string;
  username: string;
  name: string;
  avatar: string | null;
  googleId: string | null;

  @Exclude()
  password: string | null;

  emailVerified: boolean;
  onboardedAt: Date | null;
  // step 0.6: not @Exclude()'d - a user knowing their own platformRole
  // (NONE for almost everyone) isn't sensitive, unlike password.
  platformRole: PlatformRole;
  bio: string | null;
  location: string | null;
  website: string | null;
  github: string | null;
  twitter: string | null;
  linkedin: string | null;
  createdAt: Date;
  updatedAt: Date;

  constructor(partial: Partial<UserEntity>) {
    Object.assign(this, partial);
  }
}
