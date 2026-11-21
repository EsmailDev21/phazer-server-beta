import { BadRequestException } from '@nestjs/common';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Same normalisation as tags/statuses (NFKC key, collapsed whitespace), for any named definition. */
export function normalizeName(
  raw: unknown,
  label: string,
  maxLength = 100,
): { name: string; nameKey: string } {
  if (typeof raw !== 'string') {
    throw new BadRequestException(`${label} must be a string`);
  }
  const name = raw.replace(/\s+/g, ' ').trim();
  if (CONTROL_CHARS.test(name)) {
    throw new BadRequestException(`${label} contains control characters`);
  }
  if (name.length === 0) {
    throw new BadRequestException(`${label} must not be blank`);
  }
  if (name.length > maxLength) {
    throw new BadRequestException(
      `${label} must be at most ${maxLength} characters`,
    );
  }
  return {
    name,
    nameKey: name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(),
  };
}
