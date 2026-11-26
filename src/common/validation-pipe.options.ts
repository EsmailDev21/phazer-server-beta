import type { ValidationPipeOptions } from '@nestjs/common';

/** The options of the app's global ValidationPipe, shared so tests can run the pipe exactly as production does. */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true, // strip properties not declared in the DTO
  forbidNonWhitelisted: true, // reject requests with unexpected extra fields
  transform: true, // enable @Type() coercion (PaginationDto, etc.)
  transformOptions: { enableImplicitConversion: true },
};
