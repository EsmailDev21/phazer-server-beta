import { CreateTagDto } from './create-tag.dto';

/** Rename. Same rules as create; `name` is required (a PATCH with nothing to change is a 400). */
export class UpdateTagDto extends CreateTagDto {}
