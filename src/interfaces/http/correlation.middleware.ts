import type { NextFunction, Request, Response } from 'express';
import { newId } from '../../domain/shared/ids';
import { withLogContext } from '../../observability/logger';

const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Accepts X-Correlation-Id (if well-formed) or generates one; echoes it back. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-correlation-id');
  const correlationId = incoming && SAFE.test(incoming) ? incoming : newId();
  res.setHeader('X-Correlation-Id', correlationId);
  withLogContext({ correlationId }, () => next());
}
