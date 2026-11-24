import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';

/** Keys the envelope owns; anything else on a thrown body is a domain payload and is passed through. */
const ENVELOPE_KEYS = new Set(['statusCode', 'message', 'error', 'code', 'details', 'requestId', 'timestamp']);

interface ErrorEnvelope {
  statusCode: number;
  message: string | string[];
  error: string;
  /** Optional machine-readable discriminator + payload (e.g. TRANSITION_NOT_ALLOWED). Absent for plain errors. */
  code?: string;
  details?: unknown;
  /** Domain payload fields (issues, plan, report...) thrown next to `code`. */
  [payload: string]: unknown;
  requestId: string;
  timestamp: string;
}

/**
 * Foundations Operational Hardening — ONE global exception filter.
 *
 * Consolidates the ~5 duplicated handlePrismaError copies (tasks/projects/
 * org services) into one shared provider. Response envelope is fixed:
 *   { statusCode, message, error, requestId, timestamp }
 * Stack traces NEVER reach the client, in any environment.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId =
      (request.headers['x-request-id'] as string | undefined) ?? randomUUID();

    const envelope = this.buildEnvelope(exception, requestId);

    // Structured server-side log only — never leak stack traces to the client.
    this.logger.error(
      `[${requestId}] ${request.method} ${request.url} -> ${envelope.statusCode} ${envelope.error}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(envelope.statusCode).json(envelope);
  }

  private buildEnvelope(exception: unknown, requestId: string): ErrorEnvelope {
    const timestamp = new Date().toISOString();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : (((body as Record<string, unknown>).message as string | string[]) ??
            exception.message);

      // Additive: an exception built as { message, code, details } keeps them. Every
      // existing exception is a plain string/{message}, so their envelope is unchanged.
      const extra =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : {};
      // Every domain error in this codebase is thrown as { code, message, issues | plan | report | ... }:
      // the payload sits next to `code`, not under `details`. It used to be dropped here, so a rejected rule or
      // template reached the person as just "This rule is not valid", with no way to see which part and why.
      // The other fields are passed through, never overriding the envelope's own.
      const passthrough = Object.fromEntries(
        Object.entries(extra).filter(([key]) => !ENVELOPE_KEYS.has(key)),
      );
      return {
        ...passthrough,
        statusCode: status,
        message,
        error: HttpStatus[status] ?? 'Error',
        ...(typeof extra.code === 'string' ? { code: extra.code } : {}),
        ...(extra.details !== undefined ? { details: extra.details } : {}),
        requestId,
        timestamp,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrismaKnownError(exception, requestId, timestamp);
    }

    if (
      exception instanceof Prisma.PrismaClientValidationError ||
      exception instanceof Prisma.PrismaClientInitializationError
    ) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Invalid request',
        error: 'Bad Request',
        requestId,
        timestamp,
      };
    }

    // Unknown/unexpected error — never leak internals.
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'Internal Server Error',
      requestId,
      timestamp,
    };
  }

  private mapPrismaKnownError(
    exception: Prisma.PrismaClientKnownRequestError,
    requestId: string,
    timestamp: string,
  ): ErrorEnvelope {
    switch (exception.code) {
      case 'P2002': {
        const target = (exception.meta?.target as string[] | undefined)?.join(
          ', ',
        );
        return {
          statusCode: HttpStatus.CONFLICT,
          message: target
            ? `A record with this ${target} already exists`
            : 'Duplicate record',
          error: 'Conflict',
          requestId,
          timestamp,
        };
      }
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Record not found',
          error: 'Not Found',
          requestId,
          timestamp,
        };
      case 'P2003':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Invalid reference to a related record',
          error: 'Bad Request',
          requestId,
          timestamp,
        };
      default:
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Database request could not be processed',
          error: 'Bad Request',
          requestId,
          timestamp,
        };
    }
  }
}
