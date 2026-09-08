import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { errorMessage, errorField } from '../services/errors';

export const errorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled Error:', err);

  const status = errorField<number>(err, 'status') || 500;

  // 4xx messages are written for the caller; 5xx messages are internal and can leak
  // file paths, SQL or upstream detail, so they are replaced in production.
  const message =
    status < 500 || !config.IS_PRODUCTION
      ? errorMessage(err, 'Internal Server Error')
      : 'Internal Server Error';

  res.status(status).json({ error: message });
};
