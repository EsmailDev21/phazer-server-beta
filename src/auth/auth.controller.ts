import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from './interfaces/jwt-payload.interface';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { GoogleProfile } from './strategies/google.strategy';

// 5 req/min per IP — Foundations Operational Hardening throttle spec.
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Sets the SAME httpOnly cookies the Google OAuth callback already set,
   * on every token-issuing flow (register/login/refresh) — not just OAuth.
   * ADDED for the Activity/Notifications module's SSE endpoint: a browser
   * EventSource can't send a custom Authorization header, so cookie-based
   * auth needs to work for every login method, not only Google's, or SSE
   * would silently fail for the majority of users. JSON body tokens are
   * still returned too, for mobile/non-cookie clients.
   */
  /**
   * SameSite/secure are configurable, not hardcoded — a same-origin
   * deployment (Next.js reverse-proxied behind the same domain as the
   * API) works fine with the 'lax' default, but a genuinely cross-origin
   * deployment (separate domains) needs sameSite:'none', which the
   * SameSite=None spec requires to be paired with secure:true (browsers
   * reject SameSite=None without Secure) — so COOKIE_SAME_SITE=none also
   * forces secure regardless of NODE_ENV, since that combination is
   * meaningless without HTTPS anyway.
   */
  private setAuthCookies(
    res: Response,
    tokens: { accessToken: string; refreshToken: string },
  ): void {
    const isProd = this.configService.get<string>('NODE_ENV') === 'production';
    const sameSite = (this.configService.get<string>('COOKIE_SAME_SITE') ??
      'lax') as 'lax' | 'none' | 'strict';
    const secure = isProd || sameSite === 'none';

    res.cookie('accessToken', tokens.accessToken, {
      httpOnly: true,
      secure,
      sameSite,
      maxAge: 15 * 60 * 1000,
    });
    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure,
      sameSite,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(
      dto,
      req.headers['user-agent'],
    );
    this.setAuthCookies(res, result);
    return result;
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto, req.headers['user-agent']);
    this.setAuthCookies(res, result);
    return result;
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.refresh(
      dto.refreshToken,
      req.headers['user-agent'],
    );
    this.setAuthCookies(res, result);
    return result;
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(dto.refreshToken);
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('verify-email')
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.authService.verifyEmail(dto.token);
    return { verified: true };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('resend-verification')
  async resendVerification(@Body() dto: ResendVerificationDto) {
    await this.authService.resendVerification(dto.email);
    // Deliberately generic — never reveal whether the email exists.
    return {
      message: 'If that email exists, a verification link has been sent',
    };
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth() {
    // Guard redirects to Google's consent screen; no body needed.
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const profile = req.user as GoogleProfile;
    const user = await this.authService.findOrCreateGoogleUser(profile);
    const tokens = await this.authService.issueTokensForUser(
      user.id,
      user.email,
      req.headers['user-agent'] as string | undefined,
    );

    this.setAuthCookies(res, tokens);

    const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? '/';
    res.redirect(frontendUrl);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user.userId);
  }
}
