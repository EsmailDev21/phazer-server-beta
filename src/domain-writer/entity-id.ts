import { randomBytes } from 'crypto';

/**
 * cuid-shaped id (25 chars, leading 'c', lowercase base36/hex) for rows the
 * bulk path inserts with createManyAndReturn. Generated here, not by Prisma,
 * so the id of every row is known BEFORE the insert: assignees and activity
 * rows are matched to their task by id, never by the order the database
 * happens to return rows in.
 *
 * Not a cryptographic id; uniqueness comes from 6 bytes of time-ordered
 * prefix plus 8 random bytes (64 bits) - collision odds are negligible at
 * import scale, and the primary key would reject one loudly anyway.
 */
export function newEntityId(): string {
  const time = Date.now().toString(36).padStart(9, '0').slice(-9);
  const rand = randomBytes(8).toString('hex').slice(0, 15);
  return `c${time}${rand}`;
}
