import { SeedDefinition } from '../seed.types';
import { contentCalendarBlueprint } from './content-calendar.blueprint';
import { sprintBoardBlueprint } from './sprint-board.blueprint';
import { studentWorkspaceBlueprint } from './student-workspace.blueprint';

const ESSAY_RUBRIC = `# Essay rubric

Score each row from 1 (weak) to 4 (excellent). The essay is worth the total out of 20.

| Criterion | What a 4 looks like |
|---|---|
| Argument | One clear claim, argued from the first paragraph to the last. |
| Evidence | Every claim rests on a cited source; sources are weighed, not just listed. |
| Structure | Each paragraph does one job; the order is the order the argument needs. |
| Style | Plain, precise sentences; no filler; terms defined on first use. |
| Mechanics | Citations are consistent; spelling and grammar do not distract. |

Hand in an outline first, then a draft, then the final essay. Feedback on the draft is the point of the draft.
`;

/**
 * The first-party templates. Order is the order they are published in. A definition is the SOURCE
 * of the template: change it and the next seeder run publishes a new version (never an edit).
 */
export const SEED_DEFINITIONS: SeedDefinition[] = [
  {
    seedKey: 'student-workspace',
    blueprint: studentWorkspaceBlueprint,
    files: [
      {
        key: 'rubric',
        fileName: 'essay-rubric.md',
        mimeType: 'text/markdown',
        text: ESSAY_RUBRIC,
      },
    ],
    tags: ['student', 'course', 'semester'],
    initialChangelog: 'First release.',
    changelog:
      'Adds ready-made automations (all start switched off) and saved views.',
  },
  {
    seedKey: 'sprint-board',
    blueprint: sprintBoardBlueprint,
    tags: ['scrum', 'sprint', 'agile'],
    initialChangelog: 'First release.',
    changelog:
      'Adds ready-made automations (all start switched off) and saved views.',
  },
  {
    seedKey: 'content-calendar',
    blueprint: contentCalendarBlueprint,
    tags: ['marketing', 'content', 'calendar'],
    initialChangelog: 'First release.',
    changelog:
      'Adds ready-made automations (all start switched off) and saved views.',
  },
];
