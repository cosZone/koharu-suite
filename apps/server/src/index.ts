import {
  resolveAuthConfig,
  resolveDatabaseUrl,
  resolveMediaCacheConfig,
  resolvePort,
  resolvePublicApiConfig,
} from './config.js';
import { loadEnvironmentFile } from './env.js';
import { registerProcessLifecycle } from './process-lifecycle.js';
import { startServerRuntime } from './runtime.js';

loadEnvironmentFile();
const databaseUrl = resolveDatabaseUrl();
const auth = resolveAuthConfig();
const mediaCache = resolveMediaCacheConfig();
const runtime = await startServerRuntime({
  auth,
  databaseUrl,
  mediaCache,
  port: resolvePort(),
  publicApi: resolvePublicApiConfig(),
});
registerProcessLifecycle(runtime, {
  secrets: [auth.secret, databaseUrl, mediaCache.root],
});
