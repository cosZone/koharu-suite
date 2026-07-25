import {
  resolveAuthConfig,
  resolveDatabaseUrl,
  resolveMediaCacheConfig,
  resolveMediaS3Config,
  resolvePort,
  resolvePublicApiConfig,
} from './config.js';
import { captureExplicitEnvironment, resolveBootEnvironment } from './config-boot.js';
import { loadEnvironmentFile } from './env.js';
import { registerProcessLifecycle } from './process-lifecycle.js';
import { startServerRuntime } from './runtime.js';

const explicitEnv = captureExplicitEnvironment();
loadEnvironmentFile();
const databaseUrl = resolveDatabaseUrl();
const { configCenter, environment } = await resolveBootEnvironment(databaseUrl, explicitEnv);
const auth = resolveAuthConfig(environment);
const mediaCache = resolveMediaCacheConfig(environment);
const mediaS3 = resolveMediaS3Config(environment);
const runtime = await startServerRuntime({
  auth,
  configCenter,
  databaseUrl,
  mediaCache,
  mediaS3,
  port: resolvePort(),
  publicApi: resolvePublicApiConfig(environment),
});
registerProcessLifecycle(runtime, {
  secrets: [
    auth.secret,
    databaseUrl,
    mediaCache.root,
    ...(mediaS3.enabled ? [mediaS3.accessKeyId, mediaS3.secretAccessKey] : []),
  ],
});
