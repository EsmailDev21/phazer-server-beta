import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
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

  it('keeps the domain payload thrown next to the code (issues, plan, report): a rejected rule says what is wrong', () => {
    const issues = [{ code: 'TOO_SHORT', path: '/actions/0/message', message: 'message must not be empty' }];
    const b = run(
      new UnprocessableEntityException({
        code: 'AUTOMATION_INVALID',
        message: 'This rule is not valid',
        issues,
      }),
    );
    expect(b).toMatchObject({ statusCode: 422, code: 'AUTOMATION_INVALID', message: 'This rule is not valid', issues });
  });

  it('a payload can never override the envelope itself', () => {
    const b = run(new ConflictException({ message: 'm', code: 'X', requestId: 'evil', timestamp: 'evil', statusCode: 200 }));
    expect(b.statusCode).toBe(409);
    expect(b.requestId).not.toBe('evil');
    expect(b.timestamp).not.toBe('evil');
  });
});
