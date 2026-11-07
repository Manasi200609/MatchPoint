import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..'
);

dotenv.config({ path: resolve(projectRoot, '.env') });

import { JsonCaseRepository } from './repository/JsonCaseRepository.js';
import { InvestigationService } from './services/InvestigationService.js';
import {
  createApp,
  shutdownHttpServer,
  startHttpServer
} from './app.js';

const repo = new JsonCaseRepository();
const service = new InvestigationService(repo);
const app = createApp(service, repo);

const port = Number(process.env.PORT) || 4000;

let server;
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;

  stopping = true;
  console.log(`MATCHPOINT shutting down (${signal}).`);

  try {
    await shutdownHttpServer(service, server);
  } catch (error) {
    console.error(
      'MATCHPOINT shutdown cleanup failed.',
      error?.message || 'unknown error'
    );
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

try {
  await repo.init();

  if (!stopping) {
    ({ server } = startHttpServer(app, service, port));
  }
} catch (error) {
  console.error(
    'Could not initialize MATCHPOINT storage.',
    error?.message || 'unknown error'
  );

  process.exitCode = 1;
  await service.shutdown();
}