import {
  Redirect,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AttachmentsService } from './attachments.service';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { QueryFilesDto } from './dto/query-files.dto';
import { RequireAccess } from '../access-control/decorators/require-access.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

// 20 req/min per IP — uploads are user-initiated and infrequent compared
// to reads, per FILES__UPLOAD__ENDPOINTS's explicit rate limit.
const UPLOAD_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

@Controller('files')
export class AttachmentsController {
  constructor(private readonly attachmentsService: AttachmentsService) {}

  // No @RequireAccess — uploadFile has three valid scopes (TASK|PROJECT|
  // COMMENT), only one known at request time. AttachmentsService checks
  // permission manually, same pattern as comments/reactions.
  @Throttle(UPLOAD_THROTTLE)
  @Post('upload-url')
  async createUploadUrl(
    @Body() dto: CreateUploadUrlDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attachmentsService.createUploadUrl(dto, user.userId);
  }

  @Post(':id/confirm')
  async confirmUpload(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attachmentsService.confirmUpload(id, user.userId);
  }

  // No @RequireAccess — visibility-gated (CLIENT-inclusive), same
  // reasoning as GET /tasks, GET /projects/:id, GET /comments.
  @Get()
  async list(
    @Query() query: QueryFilesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attachmentsService.listByTarget(query, user.userId);
  }

  /**
   * Step 4.7b. A STABLE address for a file, safe to put in a task's text (`![](/files/<id>/content)`): the signed storage URLs
   * expire after minutes, this one does not. Same permission as download-url (checked per request, with the session cookie the
   * browser sends for an <img>), then a redirect to a fresh signed URL.
   */
  @Redirect()
  @Get(':id/content')
  async getContent(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const { downloadUrl } = await this.attachmentsService.getDownloadUrl(id, user.userId);
    return { url: downloadUrl, statusCode: 302 };
  }

  @Get(':id/download-url')
  async getDownloadUrl(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attachmentsService.getDownloadUrl(id, user.userId);
  }

  @RequireAccess('deleteFile')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.attachmentsService.delete(id);
  }
}
