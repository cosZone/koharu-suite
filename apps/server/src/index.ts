import {
  resolveAuthConfig,
  resolveDatabaseUrl,
  resolveMediaCacheConfig,
  resolveMediaS3Config,
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
const mediaS3 = resolveMediaS3Config();
const runtime = await startServerRuntime({
  auth,
  databaseUrl,
  mediaCache,
  mediaS3,
  port: resolvePort(),
  publicApi: resolvePublicApiConfig(),
});
registerProcessLifecycle(runtime, {
  secrets: [
    auth.secret,
    databaseUrl,
    mediaCache.root,
    ...(mediaS3.enabled ? [mediaS3.accessKeyId, mediaS3.secretAccessKey] : []),
  ],
});
