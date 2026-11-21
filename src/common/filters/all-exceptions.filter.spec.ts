import { ConflictException, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function run(exception: unknown) {
  let body: any;
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => ({ status: () => ({ json: (b: any) => (body = b) }) }),
      getRequest: () => ({ headers: {}, method: 'GET', url: '/x' }),
    }),
  };
  new AllExceptionsFilter().catch(exception, host);
  return body;
}

describe('AllExceptionsFilter envelope', () => {
  it('plain exceptions keep the fixed envelope (no code/details keys)', () => {
    const b = run(new NotFoundException('nope'));
    expect(b).toMatchObject({ statusCode: 404, message: 'nope' });
    expect(b).not.toHaveProperty('code');
    expect(b).not.toHaveProperty('details');
  });

  it('passes through an optional code and details (ADR-0006 TRANSITION_NOT_ALLOWED)', () => {
    const b = run(
      new ConflictException({ message: 'm', code: 'X', details: { a: [1] } }),
    );
    expect(b).toMatchObject({
      statusCode: 409,
      message: 'm',
      code: 'X',
      details: { a: [1] },
    });
  });
});
