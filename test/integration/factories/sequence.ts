/** Monotonic counter so factory-generated emails/usernames/names never
 * collide within a test run, without depending on random UUIDs (which make
 * failing-test output harder to read than "user-7@test.local"). Reset is
 * intentionally NOT tied to resetDb() - uniqueness across the whole process
 * is what matters, not per-test. */
let n = 0;
export function nextSeq(): number {
  n += 1;
  return n;
}
