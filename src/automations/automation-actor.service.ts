import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Never receives mail (RFC 2606 reserves .invalid) and has no password or Google id: nobody can sign in as it. */
export const AUTOMATION_USER_EMAIL = 'system-automations@automations.invalid';
const USERNAME = 'automations-system';

/**
 * The "person" automation writes are attributed to: shown as the author of its comments and the actor
 * of its changes, so a rule's work is recognisable and is never mistaken for the rule's creator's.
 * It belongs to no account and has access to nothing; it only ever appears as an author/actor id.
 */
@Injectable()
/** Looked up on every run (one indexed query) rather than cached: a cached id would silently turn into a foreign-key failure if the row were ever removed or recreated. */
export class AutomationActorService {
  constructor(private readonly prisma: PrismaService) {}

  async userId(): Promise<string> {
    const find = () =>
      this.prisma.user.findUnique({
        where: { email: AUTOMATION_USER_EMAIL },
        select: { id: true },
      });
    let user = await find();
    if (!user) {
      try {
        user = await this.prisma.user.create({
          data: {
            email: AUTOMATION_USER_EMAIL,
            username: USERNAME,
            name: 'Automations',
            emailVerified: true,
          },
          select: { id: true },
        });
      } catch (err) {
        if (!(
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ))
          throw err;
        user = await find(); // another instance created it first
        if (!user) throw err;
      }
    }
    return user.id;
  }
}
