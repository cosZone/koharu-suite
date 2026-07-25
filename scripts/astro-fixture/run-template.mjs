import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURE_MESSAGE_ID, startSuiteApiFixture } from './suite-api.mjs';
import {
  createTemporaryDirectory,
  getFreePort,
  packKoharuAstro,
  removeTemporaryDirectory,
  repositoryRoot,
  runCommand,
  startAstroServer,
  stopAstroServer,
  waitForHttp,
} from './support.mjs';

const metadata = JSON.parse(
  await readFile(join(repositoryRoot, 'scripts/astro-fixture/template.json'), 'utf8'),
);
const sourceFixture = join(repositoryRoot, 'tests/fixtures/astro-consumer/dynamic-on');
const overlayRoot = join(repositoryRoot, 'scripts/astro-fixture/template-overlay');
const temporaryRoot = await createTemporaryDirectory('koharu-astro-template-');
const artifacts = join(temporaryRoot, 'artifacts');
const staticDirectory = join(temporaryRoot, 'static-off');
const dynamicDirectory = join(temporaryRoot, 'dynamic-on');

let dynamicServer;
let suiteApi;
let trapApi;

async function clonePinnedTemplate(destination) {
  await runCommand('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    metadata.tag,
    metadata.repository,
    destination,
  ]);
  const commitProcess = await import('node:child_process').then(({ execFileSync }) =>
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: destination,
      encoding: 'utf8',
    }),
  );
  assert.equal(commitProcess.trim(), metadata.commit, 'Template tag moved from its pinned commit');
  await runCommand('git', ['remote', 'remove', 'origin'], { cwd: destination });
}

async function installTemplateDependencies(directory, tarball, includeNodeAdapter) {
  await runCommand('pnpm', ['install', '--frozen-lockfile'], { cwd: directory });
  const dependencies = [tarball];
  if (includeNodeAdapter) {
    dependencies.push('@astrojs/node@10.1.4');
  }
  await runCommand('pnpm', ['add', '--save-exact', ...dependencies], { cwd: directory });
}

try {
  await mkdir(artifacts);
  const tarball = await packKoharuAstro(artifacts);

  await clonePinnedTemplate(staticDirectory);
  await installTemplateDependencies(staticDirectory, tarball, false);
  trapApi = await startSuiteApiFixture({ failOnApiRequest: true });
  await runCommand('pnpm', ['exec', 'astro', 'check'], {
    cwd: staticDirectory,
    env: {
      KOHARU_SUITE_ENABLED: 'false',
      KOHARU_SUITE_URL: trapApi.origin,
    },
  });
  await runCommand('pnpm', ['exec', 'astro', 'build'], {
    cwd: staticDirectory,
    env: {
      KOHARU_SUITE_ENABLED: 'false',
      KOHARU_SUITE_URL: trapApi.origin,
    },
  });
  await access(join(staticDirectory, 'dist/index.html'));
  await assert.rejects(access(join(staticDirectory, 'dist/server/entry.mjs')));
  assert.deepEqual(trapApi.getCalls(), {}, 'Pinned static template unexpectedly called suite');
  await trapApi.close();
  trapApi = undefined;

  await clonePinnedTemplate(dynamicDirectory);
  await installTemplateDependencies(dynamicDirectory, tarball, true);
  await rename(
    join(dynamicDirectory, 'astro.config.mjs'),
    join(dynamicDirectory, 'astro.fixture.base.config.mjs'),
  );
  await cp(
    join(overlayRoot, 'astro.fixture.config.mjs'),
    join(dynamicDirectory, 'astro.config.mjs'),
  );
  await cp(join(sourceFixture, 'src/live.config.ts'), join(dynamicDirectory, 'src/live.config.ts'));
  await cp(
    join(sourceFixture, 'src/pages/archive'),
    join(dynamicDirectory, 'src/pages/koharu-fixture'),
    { recursive: true },
  );

  suiteApi = await startSuiteApiFixture();
  await runCommand('pnpm', ['exec', 'astro', 'check'], {
    cwd: dynamicDirectory,
    env: { KOHARU_SUITE_URL: suiteApi.origin },
  });
  assert.deepEqual(suiteApi.getCalls(), {}, 'Pinned dynamic template check fetched suite');
  await runCommand('pnpm', ['exec', 'astro', 'build'], {
    cwd: dynamicDirectory,
    env: { KOHARU_SUITE_URL: suiteApi.origin },
  });
  await access(join(dynamicDirectory, 'dist/server/entry.mjs'));
  assert.deepEqual(suiteApi.getCalls(), {}, 'Pinned dynamic template fetched suite during build');

  const port = await getFreePort();
  dynamicServer = startAstroServer(dynamicDirectory, port, {
    KOHARU_SUITE_URL: suiteApi.origin,
  });
  const astroOrigin = `http://127.0.0.1:${port}`;
  await waitForHttp(`${astroOrigin}/`, dynamicServer, 60_000);

  const staticResponse = await fetch(`${astroOrigin}/`);
  assert.equal(staticResponse.status, 200);
  assert.deepEqual(
    suiteApi.getCalls(),
    {},
    'Pinned template static page unexpectedly called suite',
  );

  const archiveResponse = await fetch(`${astroOrigin}/koharu-fixture/`);
  assert.equal(archiveResponse.status, 200);
  assert.match(await archiveResponse.text(), /Synthetic Koharu Channel/u);

  const detailResponse = await fetch(`${astroOrigin}/koharu-fixture/${FIXTURE_MESSAGE_ID}`);
  assert.equal(detailResponse.status, 200);
  assert.match(await detailResponse.text(), /data-suite-rendered="true"/u);

  process.stdout.write(
    `Pinned astro-koharu template smoke passed (${metadata.tag} ${metadata.commit}).\n`,
  );
} finally {
  if (dynamicServer) {
    await stopAstroServer(dynamicServer).catch(() => {
      dynamicServer.child.kill('SIGKILL');
    });
  }
  await suiteApi?.close().catch(() => {});
  await trapApi?.close().catch(() => {});
  await removeTemporaryDirectory(temporaryRoot);
}
