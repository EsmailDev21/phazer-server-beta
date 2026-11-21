import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequireAccess } from '../access-control/decorators/require-access.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireFeature } from '../feature-flags/require-feature.decorator';
import {
  CreateTemplateDto,
  DiffQueryDto,
  DiscardDraftQueryDto,
  ExportTemplateDto,
  ForkTemplateDto,
  ListPublicTemplatesQueryDto,
  ListTemplatesQueryDto,
  NewVersionDto,
  PatchDraftDto,
  PublishDraftDto,
  UpdateTemplateDto,
} from './dto/template.dto';
import { ApplyTemplateDto, UndoInstallDto } from './dto/apply.dto';
import { TemplateApplyService } from './apply/apply.service';
import { BLUEPRINT_LIMITS } from './blueprint';
import { TemplateAssetsService } from './assets/template-assets.service';
import { TemplateEditorService } from './editor/template-editor.service';
import { TemplatesService } from './templates.service';

/** Reads a raw request body, refusing as soon as it passes `max` (never buffers more than max + one chunk). */
async function readCapped(req: Request, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    throw new UnprocessableEntityException({
      code: 'ASSET_REFUSED',
      reason: 'TOO_LARGE',
      message: 'This file is too large',
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max)
      throw new UnprocessableEntityException({
        code: 'ASSET_REFUSED',
        reason: 'TOO_LARGE',
        message: 'This file is too large',
      });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Step 3.5. 404 while FEATURE_TEMPLATES is off (ADR-0002). The `:id` of each route is the id of
 * the thing the route is ABOUT (account / workspace / template), which is what the access guard
 * resolves. Reading is not an ACTION_CONFIG action: it is decided in the service (creator,
 * account OWNER/ADMIN, or ACCOUNT visibility for MEMBERs) and answers 404, never 403.
 */
@RequireFeature('TEMPLATES')
@Controller()
export class TemplatesController {
  constructor(
    private readonly service: TemplatesService,
    private readonly applier: TemplateApplyService,
    private readonly assets: TemplateAssetsService,
    private readonly editor: TemplateEditorService,
  ) {}

  @RequireAccess('createTemplate', { targetType: 'ACCOUNT' })
  @Post('accounts/:id/templates')
  create(
    @Param('id') accountId: string,
    @Body() dto: CreateTemplateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.createFromBlueprint(accountId, user.userId, dto);
  }

  @Get('accounts/:id/templates')
  list(
    @Param('id') accountId: string,
    @Query() query: ListTemplatesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(accountId, user.userId, query);
  }

  /** Workspace (or one project) -> extract -> sanitize -> a new private template. */
  @RequireAccess('exportWorkspaceTemplate', { targetType: 'WORKSPACE' })
  @Post('workspaces/:id/export-template')
  exportTemplate(
    @Param('id') workspaceId: string,
    @Body() dto: ExportTemplateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.exportFromWorkspace(workspaceId, user.userId, dto);
  }

  /**
   * Step 3.9: the gallery of first-party (PUBLIC) templates, for any signed-in user. Declared before
   * `templates/:id` so "public" is not taken for an id.
   */
  @Get('templates/public')
  listPublic(@Query() query: ListPublicTemplatesQueryDto) {
    return this.service.listPublic(query);
  }

  @Get('templates/:id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.get(id, user.userId);
  }

  @RequireAccess('editTemplate', { targetType: 'TEMPLATE' })
  @Patch('templates/:id')
  update(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    return this.service.updateMeta(id, dto);
  }

  @RequireAccess('deleteTemplate', { targetType: 'TEMPLATE' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('templates/:id')
  async remove(@Param('id') id: string) {
    await this.service.delete(id);
  }

  @Get('templates/:id/versions')
  versions(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listVersions(id, user.userId);
  }

  @RequireAccess('editTemplate', { targetType: 'TEMPLATE' })
  @Post('templates/:id/versions')
  addVersion(
    @Param('id') id: string,
    @Body() dto: NewVersionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.addVersion(id, user.userId, dto);
  }

  /** Declared before `versions/:sequence` so "latest" is not parsed as a number. */
  @Get('templates/:id/versions/latest')
  latest(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getVersion(id, 'latest', user.userId);
  }

  @Get('templates/:id/versions/:sequence')
  version(
    @Param('id') id: string,
    @Param('sequence', ParseIntPipe) sequence: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.getVersion(id, sequence, user.userId);
  }

  /** The caller needs createTemplate on the OWNING account (body.accountId) and read access to the source. */
  @RequireAccess('createTemplate', {
    targetType: 'ACCOUNT',
    paramSource: 'body',
    paramName: 'accountId',
  })
  @Post('templates/:id/fork')
  fork(
    @Param('id') id: string,
    @Body() dto: ForkTemplateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.fork(id, user.userId, dto.accountId, dto.name);
  }

  @Get('templates/:id/lineage')
  lineage(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.lineage(id, user.userId);
  }

  // ------------------------------------------------------------------ editor (step 3.8)

  /** What changed between two versions. `from`/`to` are a version number or "latest". */
  @Get('templates/:id/diff')
  diff(
    @Param('id') id: string,
    @Query() q: DiffQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.diffVersions(id, q.from, q.to, user.userId);
  }

  @RequireAccess('editTemplate', { targetType: 'TEMPLATE' })
  @Post('templates/:id/draft')
  createDraft(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.editor.createDraft(id, user.userId);
  }

  @RequireAccess('editTemplate', { targetType: 'TEMPLATE' })
  @Get('templates/:id/draft')
  getDraft(@Param('id') id: string) {
    return this.editor.getDraft(id);
  }

  @RequireAccess('editTemplate', { targetType: 'TEMPLATE' })
  @Get('templates/:id/draft/diff')
  draftDiff(@Param('id') id: string) {
    return this.editor.diffDraft(id);
  }

  @RequireAccess('editTemplate', { targetType: 'TEMPLATE' })
  @Patch('templates/:id/draft')
  patchDraft(
    @Param('id') id: string,
    @Body() dto: PatchDraftDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.editor.patchDraft(id, user.userId, dto);
  }

  @RequireAccess('editTemplate', { targetType: 'TEMPLATE' })
  @Post('templates/:id/draft/publish')
  publishDraft(
    @Param('id') id: string,
    @Body() dto: PublishDraftDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.editor.publishDraft(id, user.userId, dto);
  }

  @RequireAccess('editTemplate', { targetType: 'TEMPLATE' })
  @Delete('templates/:id/draft')
  @HttpCode(204)
  async discardDraft(
    @Param('id') id: string,
    @Query() q: DiscardDraftQueryDto,
  ) {
    await this.editor.discardDraft(id, q.ifRevision);
  }

  // ------------------------------------------------------------------ assets (step 3.7)

  /**
   * Upload one reference file: the request BODY is the file (not JSON, not multipart), so the
   * global JSON size limit does not apply; the per-file cap does. Name and type come from the
   * `x-file-name` and `content-type` headers. Add the returned sha256/size to the blueprint's
   * `assets`, then POST a new version.
   */
  @RequireAccess('editTemplate', { targetType: 'TEMPLATE' })
  @Post('templates/:id/assets')
  async uploadAsset(
    @Param('id') id: string,
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const raw = req.headers['x-file-name'];
    const fileName = typeof raw === 'string' ? decodeURIComponent(raw) : '';
    const bytes = await readCapped(req, BLUEPRINT_LIMITS.maxAssetBytes);
    const a = await this.assets.upload(id, user.userId, {
      fileName,
      mimeType: String(req.headers['content-type'] ?? '')
        .split(';')[0]
        .trim(),
      bytes,
    });
    return {
      sha256: a.sha256,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    };
  }

  @Get('templates/:id/assets')
  async listAssets(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.service.get(id, user.userId); // readable or 404
    return this.assets.list(id);
  }

  // ------------------------------------------------------------------ apply (step 3.6)

  /** Dry run: the plan (counts, reused vs created, warnings, blockers). Writes nothing. */
  @RequireAccess('applyTemplate', {
    targetType: 'WORKSPACE',
    paramSource: 'body',
    paramName: 'workspaceId',
  })
  @HttpCode(HttpStatus.OK)
  @Post('templates/:id/apply/preview')
  previewApply(
    @Param('id') id: string,
    @Body() dto: ApplyTemplateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.applier.preview(user.userId, id, dto);
  }

  @RequireAccess('applyTemplate', {
    targetType: 'WORKSPACE',
    paramSource: 'body',
    paramName: 'workspaceId',
  })
  @Post('templates/:id/apply')
  apply(
    @Param('id') id: string,
    @Body() dto: ApplyTemplateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.applier.apply(user.userId, id, dto);
  }

  @Get('workspaces/:id/template-installs')
  installs(
    @Param('id') workspaceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.applier.listInstalls(user.userId, workspaceId);
  }

  @Get('template-installs/:id')
  install(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.applier.getInstall(user.userId, id);
  }

  /** What an undo would delete, what it would leave because it was edited, what it can never delete. */
  @Get('template-installs/:id/undo-preview')
  async undoPreview(
    @Param('id') id: string,
    @Query('confirmEdited') confirmEdited: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.applier.assertCanUndo(user.userId, id);
    return this.applier.previewUndo(user.userId, id, {
      confirmEdited: confirmEdited === 'true',
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('template-installs/:id/undo')
  async undo(
    @Param('id') id: string,
    @Body() dto: UndoInstallDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.applier.assertCanUndo(user.userId, id);
    return this.applier.undo(user.userId, id, dto);
  }
}
