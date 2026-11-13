import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { HttpError, forbidden } from './lib/errors.js';
import { loadSession } from './lib/auth.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { spaceRoutes } from './routes/spaces.js';
import { pageRoutes } from './routes/pages.js';
import { healthRoutes } from './routes/health.js';
import { templateRoutes } from './routes/templates.js';
import { attachmentRoutes } from './routes/attachments.js';
import { trashRoutes } from './routes/trash.js';
import { settingsRoutes } from './routes/settings.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_EXEMPT = new Set(['/api/v1/auth/login']);

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // CodeMirror and Shiki inject inline styles.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const baseHost = (() => {
  try {
    return new URL(config.baseUrl).host;
  } catch {
    return null;
  }
})();

function allowedOrigin(origin: string, host: string | undefined): boolean {
  let h: string;
  try {
    h = new URL(origin).host;
  } catch {
    return false;
  }
  return h === host || h === baseHost;
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cookie);

  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('csrfToken', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Frame-Options', 'DENY');
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    await loadSession(req);
    if (UNSAFE.has(req.method)) {
      // Reject cross-site requests outright, then require the per-session CSRF token.
      const origin = req.headers.origin;
      if (origin && !allowedOrigin(origin, req.headers.host)) throw forbidden('Cross-origin request rejected');
      const path = req.url.split('?')[0];
      if (!CSRF_EXEMPT.has(path) && req.user && req.headers['x-csrf-token'] !== req.csrfToken) {
        throw forbidden('Missing or invalid CSRF token');
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, details: err.details });
    }
    const e = err as { statusCode?: number; message: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: e.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'Internal server error' });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(userRoutes, { prefix: '/api/v1' });
  await app.register(spaceRoutes, { prefix: '/api/v1' });
  await app.register(pageRoutes, { prefix: '/api/v1' });
  await app.register(templateRoutes, { prefix: '/api/v1' });
  await app.register(attachmentRoutes, { prefix: '/api/v1' });
  await app.register(trashRoutes, { prefix: '/api/v1' });
  await app.register(settingsRoutes, { prefix: '/api/v1' });

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      setHeaders(res, path) {
        if (path.includes('/assets/')) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    // SPA fallback: every non-API GET serves index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'Not found' }));
  }

  return app;
}
