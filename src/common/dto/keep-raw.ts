import { Transform } from 'class-transformer';

/**
 * Leave a request property exactly as it arrived in the JSON body.
 *
 * The global ValidationPipe runs with `enableImplicitConversion: true` (so query strings become numbers and
 * booleans). For a property typed `unknown[]` that conversion is applied to every ELEMENT as if the element
 * were itself an array, so `[{ type: "SET_STATUS" }]` arrived in the service as `[[]]`: an automation's actions,
 * the template editor's `ops` and the import selections all failed with "must be an object". These properties
 * are plain JSON on purpose (their shape is checked by the DSL validator, the editor and parseSelection), so
 * they must not be converted at all.
 */
export const KeepRaw = () =>
  Transform(({ obj, key }) => (obj as Record<string, unknown>)[key], {
    toClassOnly: true,
  });
