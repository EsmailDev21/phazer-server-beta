import 'reflect-metadata';
import { ValidationPipe, type Type } from '@nestjs/common';
import { CreateAutomationDto, UpdateAutomationDto, ValidateAutomationDto } from '../../automations/dto/automation.dto';
import { validateRule } from '../../automations/dsl';
import { CreatePerSpaceImportDto, PutSelectionDto } from '../../imports/dto/imports.dto';
import { PatchDraftDto } from '../../templates/dto/template.dto';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.options';

// The pipe exactly as the app runs it (src/main.ts): implicit conversion is ON, which used to turn every
// element of an `unknown[]` property into an empty array.
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const run = <T>(metatype: Type<T>, body: unknown) => pipe.transform(JSON.parse(JSON.stringify(body)), { type: 'body', metatype }) as Promise<T>;

describe('request properties that are plain JSON arrive untouched', () => {
  const actions = [{ type: 'SET_STATUS', status: { category: 'DONE' } }, { type: 'NOTIFY', message: 'Done', users: ['ASSIGNEES'] }];

  it('automation actions (create, update, validate)', async () => {
    const rule = { trigger: { type: 'ALL_SUBTASKS_DONE' }, conditions: {}, actions };
    expect((await run(CreateAutomationDto, { name: 'Close the parent when every subtask is done', enabled: false, ...rule })).actions).toEqual(actions);
    expect((await run(UpdateAutomationDto, { actions })).actions).toEqual(actions);
    expect((await run(ValidateAutomationDto, rule)).actions).toEqual(actions);
  });

  it('the exact request that failed: it now reaches the rule validator intact and passes it', async () => {
    const dto = await run(CreateAutomationDto, {
      name: 'Close the parent when every subtask is done',
      enabled: false,
      trigger: { type: 'ALL_SUBTASKS_DONE' },
      conditions: {},
      actions: [{ type: 'SET_STATUS', status: { category: 'DONE' } }],
    });
    const { name: _name, enabled: _enabled, ...rule } = dto;
    void _name; void _enabled;
    const result = validateRule(rule);
    expect(result.ok).toBe(true);
  });

  it("the template editor's operations", async () => {
    const ops = [{ op: 'setMeta', set: { name: 'x' } }, { op: 'addTask', project: 'p1', task: { title: 'T' } }];
    expect((await run(PatchDraftDto, { ifRevision: 1, ops })).ops).toEqual(ops);
  });

  it('import selections', async () => {
    const sources = [{ id: 'a', type: 'repo' }];
    expect((await run(PutSelectionDto, { sources })).sources).toEqual(sources);
    const spaces = [{ id: 's1', name: 'Space' }];
    expect((await run(CreatePerSpaceImportDto, { connectionId: 'c1', spaces })).spaces).toEqual(spaces);
  });

  it('a body that is not an array is still refused', async () => {
    await expect(run(CreateAutomationDto, { name: 'x', trigger: { type: 'ALL_SUBTASKS_DONE' }, actions: 'nope' })).rejects.toThrow();
  });
});
