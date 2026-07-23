import {
  resolveAuthConfig,
  resolveDatabaseUrl,
  resolvePort,
  resolvePublicApiConfig,
} from './config.js';
import { loadEnvironmentFile } from './env.js';
import { registerProcessLifecycle } from './process-lifecycle.js';
import { startServerRuntime } from './runtime.js';

loadEnvironmentFile();
const databaseUrl = resolveDatabaseUrl();
const auth = resolveAuthConfig();
const runtime = startServerRuntime({
  auth,
  databaseUrl,
  port: resolvePort(),
  publicApi: resolvePublicApiConfig(),
});
registerProcessLifecycle(runtime, {
  secrets: [auth.secret, databaseUrl],
});
