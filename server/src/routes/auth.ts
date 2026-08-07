import { Router } from 'express';
import {
  authEnabled,
  clearSessionCookie,
  passwordMatches,
  setSessionCookie,
  verifyToken,
} from '../middleware/auth.js';

export const authRouter: Router = Router();

authRouter.get('/session', (req, res) => {
  res.json({
    authEnabled: authEnabled(),
    authenticated: !authEnabled() || verifyToken(req.cookies?.pm_session),
  });
});

authRouter.post('/login', (req, res) => {
  if (!authEnabled()) {
    res.json({ authenticated: true, authEnabled: false });
    return;
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || !passwordMatches(password)) {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }

  setSessionCookie(res);
  res.json({ authenticated: true, authEnabled: true });
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ authenticated: false });
});
