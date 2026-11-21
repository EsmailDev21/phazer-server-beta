import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailService } from './email.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';

const logger = new Logger('AuthModule');

const googleStrategyProvider = {
  provide: GoogleStrategy,
  useFactory: (configService: ConfigService) => {
    const clientId = configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = configService.get<string>('GOOGLE_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      logger.warn(
        'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set — Google OAuth strategy not registered. ' +
          '/auth/google and /auth/google/callback will 404 until configured.',
      );
      return null;
    }

    return new GoogleStrategy(configService);
  },
  inject: [ConfigService],
};

@Module({
  imports: [
    PassportModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, EmailService, JwtStrategy, googleStrategyProvider],
})
export class AuthModule {}
