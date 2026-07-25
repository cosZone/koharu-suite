import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function runCommand(command, args, options = {}) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${command} exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}`,
        ),
      );
    });
  });
}

export async function createTemporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTemporaryDirectory(path) {
  await rm(path, { force: true, recursive: true });
}

export async function packKoharuAstro(destination) {
  const providedTarball = process.env.KOHARU_ASTRO_TARBALL;
  if (providedTarball) {
    const tarball = resolve(repositoryRoot, providedTarball);
    await access(tarball);
    return tarball;
  }
  await runCommand('pnpm', ['--filter', '@coszone/koharu-astro', 'build']);
  await runCommand('pnpm', [
    '--filter',
    '@coszone/koharu-astro',
    'pack',
    '--pack-destination',
    destination,
  ]);
  const tarballs = (await readdir(destination))
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => join(destination, entry));
  assert.equal(tarballs.length, 1, 'Expected exactly one @coszone/koharu-astro tarball');
  return tarballs[0];
}

export async function prepareConsumerFixture(source, destination, tarball, replacements = {}) {
  await cp(source, destination, { recursive: true });
  const packageJsonPath = join(destination, 'package.json');
  let manifest = await readFile(packageJsonPath, 'utf8');
  assert.match(manifest, /__KOHARU_ASTRO_TARBALL__/u);
  manifest = manifest.replace('__KOHARU_ASTRO_TARBALL__', tarball);
  for (const [placeholder, value] of Object.entries(replacements)) {
    assert.match(manifest, new RegExp(placeholder, 'u'));
    manifest = manifest.replaceAll(placeholder, value);
  }
  await writeFile(packageJsonPath, manifest, 'utf8');
  await runCommand('pnpm', ['install', '--no-frozen-lockfile'], { cwd: destination });
}

export async function getFreePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a fixture port');
  }
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return address.port;
}

export function startAstroServer(cwd, port, env = {}) {
  const output = [];
  const child = spawn('node', ['dist/server/entry.mjs'], {
    cwd,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      output.push(chunk.toString());
    });
  }
  return {
    child,
    output: () => output.join(''),
  };
}

export async function stopAstroServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    return;
  }
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolvePromise) => server.child.once('exit', resolvePromise)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Astro fixture server did not stop')), 10_000),
    ),
  ]);
}

export async function waitForHttp(url, server, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`Astro fixture server exited early:\n${server.output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The standalone server may not have bound its port yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${url}\n${server.output()}`);
}
