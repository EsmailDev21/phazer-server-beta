import { Transform } from 'class-transformer';

/**
 * Query-string booleans, done correctly.
 *
 * `@Type(() => Boolean)` (and the global `enableImplicitConversion`) turn ANY
 * non-empty string into `true` - `?flag=false`, `?flag=0` and `?flag=banana` all
 * become `true`. This reads the RAW query value instead (class-transformer
 * coerces before `@Transform` runs, so `value` is already wrong), accepts only
 * `true`/`false`, and leaves anything else untouched so `@IsBoolean()` rejects it
 * with a 400.
 *
 * Use as `@IsOptional() @BooleanQuery() @IsBoolean() flag?: boolean`.
 */
export function BooleanQuery(): PropertyDecorator {
  return Transform(({ obj, key }) => {
    const raw: unknown = (obj as Record<string, unknown>)[key];
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    return raw;
  });
}
