import { BadRequestException } from '@nestjs/common';
import { STATUS_NAME_MAX_LENGTH } from './workflow-rules';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Same normalisation as tags (NFKC, collapsed whitespace, lower-cased key), own wording and limit. */
export function normalizeStatusName(raw: string): {
  name: string;
  nameKey: string;
} {
  if (typeof raw !== 'string') {
    throw new BadRequestException('Status name must be a string');
  }
  const name = raw.replace(/\s+/g, ' ').trim();
  if (CONTROL_CHARS.test(name)) {
    throw new BadRequestException('Status name contains control characters');
  }
  if (name.length === 0) {
    throw new BadRequestException('Status name must not be blank');
  }
  if (name.length > STATUS_NAME_MAX_LENGTH) {
    throw new BadRequestException(
      `Status name must be at most ${STATUS_NAME_MAX_LENGTH} characters`,
    );
  }
  const nameKey = name
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return { name, nameKey };
}
