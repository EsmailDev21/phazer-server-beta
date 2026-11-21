import { TaskStatus } from '@prisma/client';
import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { REQUIRE_ACCESS_KEY } from '../../access-control/decorators/require-access.decorator';
import { REQUIRE_FEATURE_KEY } from '../../feature-flags/require-feature.decorator';
import { DeleteTaskQueryDto } from './dto/delete-task-query.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { MAX_TASK_DEPTH, TreeNode, leafProgress } from './task-tree';
import { TasksController } from './tasks.controller';

const n = (
  id: string,
  parentId: string | null,
  status: TaskStatus,
  isArchived = false,
  excludeFromProgress = false,
): TreeNode => ({ id, parentId, status, isArchived, excludeFromProgress });
const { TODO, IN_PROGRESS, DONE } = TaskStatus;

describe('leafProgress (ADR-0005 decision 6)', () => {
  it('a flat list is exactly done/total - the old project progress', () => {
    const flat = [
      n('1', null, DONE),
      n('2', null, DONE),
      n('3', null, TODO),
      n('4', null, IN_PROGRESS),
    ];
    expect(leafProgress(flat)).toEqual({ done: 2, total: 4, percent: 50 });
  });

  it('rounds like the old code (1/3 = 33, 2/3 = 67)', () => {
    expect(
      leafProgress([n('a', null, DONE), n('b', null, TODO), n('c', null, TODO)])
        ?.percent,
    ).toBe(33);
    expect(
      leafProgress([n('a', null, DONE), n('b', null, DONE), n('c', null, TODO)])
        ?.percent,
    ).toBe(67);
  });

  it('parents are containers: they are not counted and their own status is ignored', () => {
    const tree = [
      n('p', null, DONE),
      n('c1', 'p', DONE),
      n('c2', 'p', TODO),
      n('t', null, TODO),
    ];
    expect(leafProgress(tree)).toEqual({ done: 1, total: 3, percent: 33 });
    // flipping the parent's own status changes nothing
    expect(
      leafProgress(
        tree.map((x) => (x.id === 'p' ? { ...x, status: TODO } : x)),
      ),
    ).toEqual({ done: 1, total: 3, percent: 33 });
  });

  it('only the deepest tasks count in a 3-level tree', () => {
    const tree = [
      n('r', null, TODO),
      n('a', 'r', TODO),
      n('g1', 'a', DONE),
      n('g2', 'a', DONE),
      n('b', 'r', TODO),
    ];
    expect(leafProgress(tree)).toEqual({ done: 2, total: 3, percent: 67 }); // g1, g2, b
  });

  it('an archived child does not make its parent a container; archived tasks never count', () => {
    const tree = [n('p', null, DONE), n('c', 'p', TODO, true)];
    expect(leafProgress(tree)).toEqual({ done: 1, total: 1, percent: 100 }); // p is a leaf again
    expect(leafProgress([n('x', null, DONE, true)])).toBeNull();
  });

  it('nothing to measure -> null (the caller decides: a project shows 0, a task shows nothing)', () => {
    expect(leafProgress([])).toBeNull();
  });

  it('is insensitive to input order', () => {
    const tree = [n('c', 'p', DONE), n('t', null, TODO), n('p', null, TODO)];
    expect(leafProgress([...tree].reverse())).toEqual(leafProgress(tree));
  });
});

describe('MAX_TASK_DEPTH', () => {
  it('is the value ADR-0005 accepted: 2 edges = 3 levels', () => {
    expect(MAX_TASK_DEPTH).toBe(2);
  });
});

// Identical options to main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
describe('update DTO and routes', () => {
  it('parentId may be a task id or null (detach) or absent; the service only ever sees a string or null', async () => {
    const body = (v: unknown) =>
      pipe.transform(v, {
        type: 'body',
        metatype: UpdateTaskDto,
      } as ArgumentMetadata);
    await expect(body({ parentId: 'abc' })).resolves.toBeDefined();
    await expect(body({ parentId: null })).resolves.toBeDefined();
    await expect(body({})).resolves.toBeDefined();
    // The global implicit conversion turns a number into its string form, which is
    // then just looked up as a task id. What matters: the service only ever sees a
    // string or null.
    expect((await body({ parentId: 5 })) as { parentId: unknown }).toEqual({
      parentId: '5',
    });
  });

  it('GET /tasks/:id/subtasks has no route guard (authorised in the service) and DELETE takes the cascade query', () => {
    expect(
      Reflect.getMetadata(
        REQUIRE_ACCESS_KEY,
        TasksController.prototype.getSubtasks,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        REQUIRE_FEATURE_KEY,
        TasksController.prototype.getSubtasks,
      ),
    ).toBeUndefined();
    const types = Reflect.getMetadata(
      'design:paramtypes',
      TasksController.prototype,
      'delete',
    );
    expect(types).toContain(DeleteTaskQueryDto);
  });
});

describe('leafProgress with excluded statuses (ADR-0006 decision 10)', () => {
  it('an excluded task is removed from both numerator and denominator', () => {
    const r = leafProgress([
      n('1', null, DONE),
      n('2', null, TODO),
      n('3', null, DONE, false, true), // Canceled
    ]);
    expect(r).toEqual({ done: 1, total: 2, percent: 50 });
  });

  it('a parent whose subtasks are ALL excluded counts as a leaf itself', () => {
    const r = leafProgress([
      n('p', null, TODO),
      n('c1', 'p', DONE, false, true),
      n('c2', 'p', DONE, false, true),
    ]);
    expect(r).toEqual({ done: 0, total: 1, percent: 0 });
  });

  it('an excluded parent with live children drops out; the children count', () => {
    const r = leafProgress([
      n('p', null, DONE, false, true),
      n('c1', 'p', DONE),
      n('c2', 'p', TODO),
    ]);
    expect(r).toEqual({ done: 1, total: 2, percent: 50 });
  });

  it('nothing but excluded tasks = nothing to measure', () => {
    expect(leafProgress([n('1', null, DONE, false, true)])).toBeNull();
  });
});
