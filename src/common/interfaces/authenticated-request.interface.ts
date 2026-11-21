import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
