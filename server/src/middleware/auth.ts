import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';

const COOKIE_NAME = 'pm_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Auth is optional in the MVP: unset APP_PASSWORD leaves the app open (Spec §7). */
export function authEnabled(): boolean {
  return env.appPassword !== null;
}

function secret(): string {
  if (env.sessionSecret) return env.sessionSecret;
  if (env.isProduction) {
    throw new Error('SESSION_SECRET must be set in production when APP_PASSWORD is configured.');
  }
  // Dev-only fallback: sessions simply don't survive a restart.
  return 'dev-only-insecure-secret';
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function issueToken(): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expected = sign(payload);
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length) return false;
  if (!crypto.timingSafeEqual(provided, expectedBuffer)) return false;

  const expiresAt = Number.parseInt(payload, 10);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

/** Constant-time password comparison, so a wrong length doesn't leak early. */
export function passwordMatches(candidate: string): boolean {
  const expected = env.appPassword;
  if (!expected) return true;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function setSessionCookie(res: Response): void {
  res.cookie(COOKIE_NAME, issueToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled()) return next();
  if (verifyToken(req.cookies?.[COOKIE_NAME])) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
