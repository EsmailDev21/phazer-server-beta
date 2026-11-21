import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UserEntity } from '../common/entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { EmailService } from './email.service';
import { GoogleProfile } from './strategies/google.strategy';

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EMAIL_VERIFICATION_TTL = '1d';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  async register(
    dto: RegisterDto,
    deviceInfo?: string,
  ): Promise<{ user: UserEntity } & TokenPair> {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { username: dto.username }] },
      select: { id: true, email: true, username: true },
    });

    if (existing) {
      const field = existing.email === dto.email ? 'email' : 'username';
      throw new ConflictException(
        `An account with this ${field} already exists`,
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        username: dto.username,
        name: dto.name,
        password: passwordHash,
      },
    });

    // FIX: no auto-created Account meant a freshly registered user could
    // never create a workspace, project, or anything else — nothing in
    // the Tenancy graph specified this, but every user needs a home
    // Account to act from. Every user gets exactly one PERSONAL account,
    // same as the personalOwnerId design already in the schema.
    await this.prisma.account.create({
      data: {
        type: 'PERSONAL',
        personalOwnerId: user.id,
        planType: 'FREE_PERSONAL',
      },
    });

    await this.sendVerificationEmail(user.id, user.email);

    const tokens = await this.issueTokenPair(user.id, user.email, deviceInfo);

    // Structured Logger only — never log email/token contents at info level.
    this.logger.log(`User registered: ${user.id}`);

    return { user: new UserEntity(user), ...tokens };
  }

  async login(
    dto: LoginDto,
    deviceInfo?: string,
  ): Promise<{ user: UserEntity } & TokenPair> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.issueTokenPair(user.id, user.email, deviceInfo);

    this.logger.log(`User logged in: ${user.id}`);

    return { user: new UserEntity(user), ...tokens };
  }

  async refresh(refreshToken: string, deviceInfo?: string): Promise<TokenPair> {
    const tokenHash = this.hashRefreshToken(refreshToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: stored.userId },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Rotation: revoke the used token and issue a brand new one.
    // NOTE: schema.prisma's RefreshToken model has no `replacedBy` column
    // (ground truth takes precedence over the graph's "replacedBy chain"
    // phrasing) — rotation is achieved by revoking the old row and creating
    // a fresh one, which gives the same one-time-use guarantee without a
    // literal linked-list pointer.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revoked: true, revokedAt: new Date(), lastUsedAt: new Date() },
    });

    return this.issueTokenPair(
      user.id,
      user.email,
      deviceInfo ?? stored.deviceInfo ?? undefined,
    );
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashRefreshToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revoked: false },
      data: { revoked: true, revokedAt: new Date() },
    });
  }

  async verifyEmail(token: string): Promise<void> {
    let payload: { sub: string; purpose: string };
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new BadRequestException('Invalid or expired verification token');
    }

    if (payload.purpose !== 'email_verification') {
      throw new BadRequestException('Invalid verification token');
    }

    await this.prisma.user.update({
      where: { id: payload.sub },
      data: { emailVerified: true },
    });
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Do not reveal whether the email exists — same response either way.
    if (!user || user.emailVerified) {
      return;
    }
    await this.sendVerificationEmail(user.id, user.email);
  }

  /**
   * Find-or-create for Google OAuth. Google-verified email is trusted as
   * emailVerified: true immediately (no separate verification flow needed).
   */
  async findOrCreateGoogleUser(profile: GoogleProfile): Promise<UserEntity> {
    if (!profile.email) {
      throw new BadRequestException('Google account has no email');
    }

    let user = await this.prisma.user.findUnique({
      where: { googleId: profile.googleId },
    });

    if (!user) {
      user = await this.prisma.user.findUnique({
        where: { email: profile.email },
      });

      if (user) {
        // Existing email/password account signing in with Google for the
        // first time — link it.
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { googleId: profile.googleId },
        });
      } else {
        const username = await this.generateUniqueUsername(profile.email);
        user = await this.prisma.user.create({
          data: {
            email: profile.email,
            username,
            name: profile.name || profile.email.split('@')[0],
            avatar: profile.avatar,
            googleId: profile.googleId,
            emailVerified: true,
          },
        });
        // Same fix as register() — brand-new users need a home Account.
        await this.prisma.account.create({
          data: {
            type: 'PERSONAL',
            personalOwnerId: user.id,
            planType: 'FREE_PERSONAL',
          },
        });
      }
    }

    return new UserEntity(user);
  }

  async issueTokensForUser(
    userId: string,
    email: string,
    deviceInfo?: string,
  ): Promise<TokenPair> {
    return this.issueTokenPair(userId, email, deviceInfo);
  }

  async getProfile(userId: string): Promise<UserEntity> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    return new UserEntity(user);
  }

  // ---- internals ----

  private async issueTokenPair(
    userId: string,
    email: string,
    deviceInfo?: string,
  ): Promise<TokenPair> {
    const payload: JwtPayload = { sub: userId, email };
    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: ACCESS_TOKEN_TTL,
    });

    const rawRefreshToken = randomBytes(48).toString('hex');
    const tokenHash = this.hashRefreshToken(rawRefreshToken);

    await this.prisma.refreshToken.create({
      data: {
        tokenHash,
        userId,
        deviceInfo,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    return { accessToken, refreshToken: rawRefreshToken };
  }

  private hashRefreshToken(token: string): string {
    // Opaque random token — sha256 for a fast, deterministic unique-index
    // lookup (bcrypt's per-call salt makes it unusable for direct lookup).
    return createHash('sha256').update(token).digest('hex');
  }

  private async sendVerificationEmail(
    userId: string,
    email: string,
  ): Promise<void> {
    const token = await this.jwtService.signAsync(
      { sub: userId, purpose: 'email_verification' },
      { expiresIn: EMAIL_VERIFICATION_TTL },
    );
    await this.emailService.sendVerificationEmail(email, token);
  }

  private async generateUniqueUsername(email: string): Promise<string> {
    const base =
      email
        .split('@')[0]
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 24) || 'user';

    let candidate = base;
    let suffix = 0;
    // Small bounded loop — collisions are rare in practice.
    while (
      await this.prisma.user.findUnique({ where: { username: candidate } })
    ) {
      suffix += 1;
      candidate = `${base}${suffix}`;
    }
    return candidate;
  }
}
