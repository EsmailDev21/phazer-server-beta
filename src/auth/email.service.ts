import { Injectable, Logger } from '@nestjs/common';

/**
 * STUB — no mail provider is wired up yet. Logs the content that would be
 * sent instead of actually sending it. Swap the body of these methods for
 * a real provider (SES, Postmark, Resend, etc.) later; the call sites in
 * AuthService should not need to change.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const verificationLink = `${process.env.APP_URL ?? 'http://localhost:3000'}/auth/verify-email?token=${token}`;
    this.logger.log(
      `[STUB] Would send verification email to ${email} — link: ${verificationLink}`,
    );
  }
}
