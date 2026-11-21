import { Conditions } from '../../automations/dsl';

export interface SortKey {
  field?: string;
  customFieldId?: string;
  dir: 'ASC' | 'DESC';
}

/** Saved-view config, v1. Ids are database ids; `ME` stands for whoever opens the view. */
export interface ViewConfigV1 {
  filters?: Conditions;
  group?: { by?: string; customFieldId?: string };
  sort?: SortKey[];
  /** built-in column names, or `custom:<fieldId>` */
  columns?: string[];
  showSubtasks?: boolean;
  hideCompleted?: boolean;
  calendar?: { dateField: string };
  timeline?: { startField: string; endField: string };
}
