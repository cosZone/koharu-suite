import { resolvePort } from './config.js';
import { loadEnvironmentFile } from './env.js';
import { registerGracefulShutdown, startServer } from './server.js';

loadEnvironmentFile();
const server = startServer(resolvePort());
registerGracefulShutdown(server);
