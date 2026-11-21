import { ValidationPipe } from '@nestjs/common';
import { QueryActivitiesDto } from '../../activity-notifications/activity/dto/query-activities.dto';
import { DeleteTaskQueryDto } from '../../projects-tasks/tasks/dto/delete-task-query.dto';
import { QueryTasksDto } from '../../projects-tasks/tasks/dto/query-tasks.dto';

// Identical options to main.ts - the point is how the REAL pipe treats query strings.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const q = (metatype: new () => unknown, value: Record<string, unknown>) =>
  pipe.transform(value, { type: 'query', metatype } as never) as Promise<
    Record<string, unknown>
  >;

describe('boolean query params (the @Type(() => Boolean) trap)', () => {
  it.each([
    ['true', true],
    ['false', false],
  ])(
    '?rootsOnly=%s -> %s (NOT "any non-empty string is true")',
    async (raw, expected) => {
      expect(
        (await q(QueryTasksDto, { workspaceId: 'w', rootsOnly: raw }))
          .rootsOnly,
      ).toBe(expected);
    },
  );

  it('?cascade=false is false', async () => {
    expect((await q(DeleteTaskQueryDto, { cascade: 'false' })).cascade).toBe(
      false,
    );
    expect((await q(DeleteTaskQueryDto, { cascade: 'true' })).cascade).toBe(
      true,
    );
    expect((await q(DeleteTaskQueryDto, {})).cascade).toBeUndefined();
  });

  it.each(['0', '1', 'yes', 'banana', ''])(
    '?rootsOnly=%j is a 400, not silently true',
    async (raw) => {
      await expect(
        q(QueryTasksDto, { workspaceId: 'w', rootsOnly: raw }),
      ).rejects.toThrow();
    },
  );

  it('REGRESSION: includeSilent=false on the activity feed used to become true (and so did "banana")', async () => {
    expect(
      (
        await q(QueryActivitiesDto, {
          workspaceId: 'w',
          includeSilent: 'false',
        })
      ).includeSilent,
    ).toBe(false);
    expect(
      (await q(QueryActivitiesDto, { workspaceId: 'w', includeSilent: 'true' }))
        .includeSilent,
    ).toBe(true);
    await expect(
      q(QueryActivitiesDto, { workspaceId: 'w', includeSilent: 'banana' }),
    ).rejects.toThrow();
  });

  it('QueryTasksDto still accepts parentId and keeps its other filters', async () => {
    const r = await q(QueryTasksDto, {
      workspaceId: 'w',
      parentId: 'p1',
      take: '10',
    });
    expect(r).toMatchObject({ workspaceId: 'w', parentId: 'p1', take: 10 });
  });
});
