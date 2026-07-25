import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const artifactDirectory = join(repositoryRoot, '.artifacts', 'koharu-astro');
const artifactPath = join(artifactDirectory, 'package.tgz');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'koharu-astro-pack-'));
const packDirectory = join(temporaryDirectory, 'pack');
const extractDirectory = join(temporaryDirectory, 'extract');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    const stderr = options.capture ? result.stderr : '';
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `:\n${stderr}` : ''}`);
  }
  return result.stdout;
}

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(path)));
    else paths.push(path);
  }
  return paths;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(extractDirectory, { recursive: true });

  run('pnpm', ['--filter', '@coszone/koharu-astro', 'build']);
  run('pnpm', ['--filter', '@coszone/koharu-astro', 'pack', '--pack-destination', packDirectory]);

  const tarballs = (await readdir(packDirectory)).filter((name) => name.endsWith('.tgz'));
  assert(tarballs.length === 1, `Expected one tarball, found ${tarballs.length}`);
  const packedTarball = join(packDirectory, tarballs[0]);

  const manifest = run('tar', ['-tzf', packedTarball], { capture: true })
    .split('\n')
    .filter(Boolean);
  const unexpected = manifest.filter(
    (path) =>
      path !== 'package' &&
      path !== 'package/' &&
      !path.startsWith('package/dist/') &&
      ![
        'package/LICENSE',
        'package/README.md',
        'package/README.en.md',
        'package/package.json',
      ].includes(path),
  );
  assert(unexpected.length === 0, `Unexpected tarball entries:\n${unexpected.join('\n')}`);

  for (const required of [
    'package/LICENSE',
    'package/README.md',
    'package/README.en.md',
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.d.ts',
  ]) {
    assert(manifest.includes(required), `Tarball is missing ${required}`);
  }

  run('tar', ['-xzf', packedTarball, '-C', extractDirectory]);
  const packedRoot = join(extractDirectory, 'package');
  const packageJson = JSON.parse(await readFile(join(packedRoot, 'package.json'), 'utf8'));
  assert(packageJson.name === '@coszone/koharu-astro', 'Unexpected package name');
  assert(packageJson.private !== true, 'Publishable package cannot be private');
  assert(packageJson.publishConfig?.access === 'public', 'publishConfig.access must be public');
  assert(packageJson.publishConfig?.provenance === true, 'publishConfig.provenance must be true');
  assert(
    packageJson.publishConfig?.registry === 'https://registry.npmjs.org/',
    'publishConfig.registry must be the public npm registry',
  );
  assert(
    packageJson.repository?.directory === 'packages/koharu-astro',
    'repository.directory is incorrect',
  );
  assert(packageJson.sideEffects === false, 'sideEffects must be false');

  const forbiddenPaths = ['src/', 'test/', 'node_modules/', '.env', '.npmrc', 'tsconfig'];
  for (const path of manifest) {
    assert(
      !forbiddenPaths.some((fragment) => path.includes(fragment)),
      `Forbidden path in tarball: ${path}`,
    );
  }

  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/,
    /\bnpm_[A-Za-z0-9]{20,}\b/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /(?:TELEGRAM_BOT_TOKEN|BETTER_AUTH_SECRET|DATABASE_URL)\s*=\s*\S+/,
    /\/Users\/[^/\s]+/,
    /astro-koharu-private/,
  ];
  for (const path of await walk(packedRoot)) {
    const relativePath = relative(packedRoot, path).split(sep).join('/');
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const pattern of secretPatterns) {
      assert(!pattern.test(text), `Sensitive content matched ${pattern} in ${relativePath}`);
    }
  }

  run('npm', [
    'publish',
    packedTarball,
    '--dry-run',
    '--access',
    'public',
    '--provenance=false',
    '--ignore-scripts',
    '--registry=https://registry.npmjs.org/',
  ]);

  await mkdir(artifactDirectory, { recursive: true });
  await cp(packedTarball, artifactPath);
  const digest = createHash('sha256')
    .update(await readFile(artifactPath))
    .digest('hex');
  console.log(`Artifact: ${artifactPath}`);
  console.log(`SHA-256: ${digest}`);

  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_OUTPUT, `tarball=${artifactPath}\nsha256=${digest}\n`);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
