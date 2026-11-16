// Entry point (Cloud Run sets PORT).
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createGeminiGenerator } from './gemini.js';
import { createGoogleTokenVerifier } from './googleAuth.js';
import { logger } from './logger.js';
import { createFirestoreStore, createMemoryStore, createQuota, metadataAccessToken } from './quota.js';

const config = loadConfig();
const store =
  config.quotaStore === 'firestore'
    ? createFirestoreStore({ project: config.project, getAccessToken: metadataAccessToken() })
    : createMemoryStore();
const app = createApp({
  config,
  generate: createGeminiGenerator(config),
  verifyGoogleToken: createGoogleTokenVerifier(config),
  quota: createQuota(config, store),
});

const server = app.listen(config.port, () => {
  logger.info('ContextTab backend started', {
    port: config.port,
    provider: config.provider,
    model: config.model,
    location: config.provider === 'vertex' ? config.location : undefined,
    ownerToken: Boolean(config.extensionToken),
    googleSignIn: config.oauthClientIds.length > 0,
    quotaStore: config.quotaStore,
    dailyLimitPerUser: config.dailyLimitPerUser || 'unlimited',
    globalDailyLimit: config.globalDailyLimit || 'unlimited',
    allowedOrigins: config.allowedOrigins.length ? config.allowedOrigins : 'chrome-extension://*',
  });
  if (config.provider === 'vertex' && !config.project) {
    logger.warn('GOOGLE_CLOUD_PROJECT is not set: every request will use the heuristic fallback.');
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
