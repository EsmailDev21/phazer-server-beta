import { Allow } from 'class-validator';

export class SetCustomValueDto {
  // Deliberately untyped/unvalidated by class-validator here — the valid
  // shape depends entirely on the target CustomField's dataType (string,
  // number, boolean, string[], ISO date string...), which isn't known
  // until the service loads the field. CustomFieldsService.validateValue
  // does the real validation against field.dataType/field.options before
  // every write — see PT__CF__VALUE_VALIDATION.
  //
  // @Allow() is REQUIRED: the global ValidationPipe uses
  // { whitelist: true, forbidNonWhitelisted: true }, and a property with no
  // class-validator decorator is treated as "not declared" and rejected with
  // 400 "property value should not exist" — which made this endpoint unusable.
  @Allow()
  value: unknown;
}
