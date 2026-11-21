import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequireAccess } from '../access-control/decorators/require-access.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireFeature } from '../feature-flags/require-feature.decorator';
import {
  CreateImportDto, CreatePerSpaceImportDto,
  IssuesQueryDto,
  ListImportsQueryDto,
  PutSelectionDto,
  ReportDownloadQueryDto,
} from './dto/imports.dto';
import { ImportsService } from './imports.service';

/**
 * Step 4.1. create -> sources -> selection -> mapping -> preview -> start, plus cancel / resume / rollback / report.
 * Create and list carry the workspace in the request, so the guard checks `runImport` there; every `:id` route
 * resolves the job's workspace and checks the same action inside the service (there is no resource id to guard yet
 * at create time, and no workspace id in the URL afterwards).
 */
@RequireFeature('IMPORTS')
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /**
   * ClickUp (diagram 06): one workspace per Space. Permissions are checked per target inside the service (creating needs
   * `createWorkspace` on the account, an existing target needs `runImport` on it), not by a decorator on one workspace id.
   */
  @Post('per-space')
  createPerSpace(@Body() dto: CreatePerSpaceImportDto, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.createPerSpace(dto, user.userId);
  }

  @RequireAccess('runImport', { paramSource: 'body', paramName: 'workspaceId' })
  @Post()
  create(@Body() dto: CreateImportDto, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.create(dto, user.userId);
  }

  @RequireAccess('runImport', { paramSource: 'query', paramName: 'workspaceId' })
  @Get()
  list(@Query() q: ListImportsQueryDto) {
    return this.imports.list(q.workspaceId);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.get(id, user.userId);
  }

  @HttpCode(204)
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.imports.delete(id, user.userId);
  }

  @Get(':id/sources')
  sources(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.sources(id, user.userId);
  }

  @Put(':id/selection')
  selection(@Param('id') id: string, @Body() dto: PutSelectionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.setSelection(id, { sources: dto.sources }, user.userId);
  }

  @Get(':id/mapping')
  mapping(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.getMapping(id, user.userId);
  }

  @Put(':id/mapping')
  setMapping(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.setMapping(id, body, user.userId);
  }

  @HttpCode(200)
  @Post(':id/preview')
  preview(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.preview(id, user.userId);
  }

  @HttpCode(202)
  @Post(':id/start')
  start(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.start(id, user.userId);
  }

  /** Step 4.9: the same previewed job, stored as a PRIVATE template instead of being written to the workspace. */
  @Post(':id/start-as-template')
  startAsTemplate(@Param('id') id: string, @Body() dto: Record<string, unknown>, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.startAsTemplate(id, dto, user.userId);
  }

  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.cancel(id, user.userId);
  }

  @HttpCode(202)
  @Post(':id/resume')
  resume(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.resume(id, user.userId);
  }

  @HttpCode(202)
  @Post(':id/rollback')
  rollback(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.rollback(id, user.userId);
  }

  @Get(':id/report')
  report(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.report(id, user.userId);
  }

  /** Step 4.9: the report as a file (CSV or JSON). */
  @Get(':id/report/download')
  async reportDownload(@Param('id') id: string, @Query() q: ReportDownloadQueryDto, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: Response) {
    const f = await this.imports.reportDownload(id, user.userId, q.format ?? 'csv');
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return f.body;
  }

  @Get(':id/issues')
  issues(@Param('id') id: string, @Query() q: IssuesQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.issuePage(id, user.userId, q);
  }
}
