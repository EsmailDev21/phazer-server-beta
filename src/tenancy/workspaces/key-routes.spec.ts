/**
 * Step 1.1: the HTTP surface of keys, pinned without a database.
 */
import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { REQUIRE_ACCESS_KEY } from '../../access-control/decorators/require-access.decorator';
import { REQUIRE_FEATURE_KEY } from '../../feature-flags/require-feature.decorator';
import { TasksController } from '../../projects-tasks/tasks/tasks.controller';
import { TaskByKeyQueryDto } from '../../projects-tasks/tasks/dto/task-by-key-query.dto';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { RenameWorkspaceKeyDto } from './dto/rename-workspace-key.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { WorkspacesController } from './workspaces.controller';

// Identical options to main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const run = (
  metatype: new () => unknown,
  value: unknown,
  type: ArgumentMetadata['type'] = 'body',
) => pipe.transform(value, { type, metatype } as ArgumentMetadata);

describe('route wiring', () => {
  it('PATCH /workspaces/:id/key: ADMIN+ (editWorkspace) and behind FEATURE_WORKFLOW', () => {
    const h = WorkspacesController.prototype.renameKey;
    expect(Reflect.getMetadata(REQUIRE_ACCESS_KEY, h)).toMatchObject({
      action: 'editWorkspace',
      targetType: 'WORKSPACE',
    });
    expect(Reflect.getMetadata(REQUIRE_FEATURE_KEY, h)).toEqual(['WORKFLOW']);
  });

  it('GET /tasks/by-key/:key: behind FEATURE_WORKFLOW, NO route guard (authorised in the service), and declared before :id', () => {
    const h = TasksController.prototype.getByKey;
    expect(Reflect.getMetadata(REQUIRE_FEATURE_KEY, h)).toEqual(['WORKFLOW']);
    expect(Reflect.getMetadata(REQUIRE_ACCESS_KEY, h)).toBeUndefined();
    // Nest registers routes in declaration order: 'by-key/:key' must precede ':id'
    // or a request for /tasks/by-key/ENG-1 would never be shadowed - but ':id'
    // is single-segment so this is belt and braces against a future ':id/*' route.
    const order = Object.getOwnPropertyNames(TasksController.prototype);
    expect(order.indexOf('getByKey')).toBeLessThan(order.indexOf('getDetail'));
  });
});

describe('DTO boundary', () => {
  it('a plain workspace update CANNOT set the key (it would bypass alias bookkeeping)', async () => {
    await expect(
      run(UpdateWorkspaceDto, { name: 'x', key: 'ENG' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(UpdateWorkspaceDto, { key: 'ENG' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(UpdateWorkspaceDto, { name: 'fine' }),
    ).resolves.toBeDefined();
  });

  it('workspace create accepts an optional key; rename requires one', async () => {
    await expect(
      run(CreateWorkspaceDto, { accountId: 'a', name: 'n', key: 'ENG' }),
    ).resolves.toBeDefined();
    await expect(
      run(CreateWorkspaceDto, { accountId: 'a', name: 'n' }),
    ).resolves.toBeDefined();
    await expect(run(RenameWorkspaceKeyDto, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      run(RenameWorkspaceKeyDto, { key: 'PLAT' }),
    ).resolves.toBeDefined();
    await expect(
      run(RenameWorkspaceKeyDto, { key: 'PLAT', extra: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('by-key needs accountId (a key alone is ambiguous across accounts)', async () => {
    await expect(run(TaskByKeyQueryDto, {}, 'query')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      run(TaskByKeyQueryDto, { accountId: '' }, 'query'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(TaskByKeyQueryDto, { accountId: 'acc_1' }, 'query'),
    ).resolves.toBeDefined();
  });
});
