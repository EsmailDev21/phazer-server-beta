import { ForbiddenException } from '@nestjs/common';
import { REDIRECT_METADATA } from '@nestjs/common/constants';
import { AttachmentsController } from './attachments.controller';

describe('GET /files/:id/content (step 4.7b)', () => {
  const user = { userId: 'u1' } as never;

  it('redirects (302) to a fresh signed URL, after the SAME permission check as download-url', async () => {
    const svc = { getDownloadUrl: jest.fn(async () => ({ downloadUrl: 'https://signed/x?sig=1', expiresAt: new Date() })) };
    const c = new AttachmentsController(svc as never);
    expect(await c.getContent('a1', user)).toEqual({ url: 'https://signed/x?sig=1', statusCode: 302 });
    expect(svc.getDownloadUrl).toHaveBeenCalledWith('a1', 'u1');
  });

  it('is declared as a redirect route', () => {
    expect(Reflect.getMetadata(REDIRECT_METADATA, AttachmentsController.prototype.getContent)).toBeDefined();
  });

  it('a person without access gets the service\'s refusal, never a URL', async () => {
    const svc = { getDownloadUrl: jest.fn(async () => { throw new ForbiddenException('no'); }) };
    await expect(new AttachmentsController(svc as never).getContent('a1', user)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
