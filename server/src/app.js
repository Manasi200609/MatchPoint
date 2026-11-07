
import express from 'express';
import cors from 'cors';
import { makeRouter } from './routes.js';

export function createApp(service, repo, env = process.env) {
  const app = express();

  app.use(cors({ origin: env.CLIENT_ORIGIN || 'http://localhost:5173' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (_req, res, next) => {
    try {
      res.json({
        ok: true,
        storage: 'local-json',
        switch: await service.integrationStatus()
      });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', makeRouter(service, repo));

  app.use((error, _req, res, _next) => {
    console.error('MATCHPOINT request failed.', {
      name: error?.name || 'Error',
      code: error?.code || 'unknown'
    });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export function startHttpServer(
  app,
  service,
  port,
  onStartError = error => {
    console.error('Could not start Switch sessions.', {
      role: error?.role || null,
      phase: error?.phase || null,
      code: error?.code || 'unknown'
    });
  },
  onServerError = error => {
    console.error('MATCHPOINT HTTP server error.', {
      code: error?.code || 'unknown'
    });
  }
) {
  const server = app.listen(port, () => {
    console.log(`MATCHPOINT API listening at http://localhost:${port}`);
  });

  // Keep compatibility with lightweight test doubles.
  if (typeof server?.on === 'function') {
    server.on('error', onServerError);
  }

  // HTTP listening must not wait for Switch agent startup.
  const initialStart = Promise.resolve()
    .then(() => service.start())
    .catch(error => {
      onStartError(error);
      return null;
    });

  return { server, initialStart };
}

export async function shutdownHttpServer(service, server) {
  let shutdownError = null;

  try {
    await service.shutdown();
  } catch (error) {
    shutdownError = error;
  }

  // Close the HTTP server even if agent cleanup failed.
  // `undefined` listening state is allowed for test doubles.
  if (
    server &&
    typeof server.close === 'function' &&
    server.listening !== false
  ) {
    try {
      await new Promise((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    } catch (error) {
      shutdownError ??= error;
    }
  }

  if (shutdownError) throw shutdownError;
}
