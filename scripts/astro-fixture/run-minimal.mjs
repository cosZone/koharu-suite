import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURE_MESSAGE_ID, startSuiteApiFixture } from './suite-api.mjs';
import {
  createTemporaryDirectory,
  getFreePort,
  packAstroLoader,
  prepareConsumerFixture,
  removeTemporaryDirectory,
  repositoryRoot,
  runCommand,
  startAstroServer,
  stopAstroServer,
  waitForHttp,
} from './support.mjs';

const fixtureRoot = join(repositoryRoot, 'tests/fixtures/astro-consumer');
const temporaryRoot = await createTemporaryDirectory('koharu-astro-loader-fixture-');
const artifacts = join(temporaryRoot, 'artifacts');
const staticDirectory = join(temporaryRoot, 'static-off');
const dynamicDirectory = join(temporaryRoot, 'dynamic-on');

let dynamicServer;
let suiteApi;
let trapApi;

try {
  await mkdir(artifacts);
  const tarball = await packAstroLoader(artifacts);

  trapApi = await startSuiteApiFixture({ failOnApiRequest: true });
  await prepareConsumerFixture(join(fixtureRoot, 'static-off'), staticDirectory, tarball);
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
  assert.deepEqual(trapApi.getCalls(), {}, 'Static-off build unexpectedly called suite');
  await trapApi.close();
  trapApi = undefined;

  suiteApi = await startSuiteApiFixture();
  await prepareConsumerFixture(join(fixtureRoot, 'dynamic-on'), dynamicDirectory, tarball);
  await runCommand('pnpm', ['exec', 'astro', 'check'], {
    cwd: dynamicDirectory,
    env: { KOHARU_SUITE_URL: suiteApi.origin },
  });
  assert.deepEqual(suiteApi.getCalls(), {}, 'Dynamic check fetched live content before runtime');
  await runCommand('pnpm', ['exec', 'astro', 'build'], {
    cwd: dynamicDirectory,
    env: { KOHARU_SUITE_URL: suiteApi.origin },
  });
  await access(join(dynamicDirectory, 'dist/server/entry.mjs'));
  assert.deepEqual(suiteApi.getCalls(), {}, 'Dynamic build fetched live content before runtime');

  const port = await getFreePort();
  dynamicServer = startAstroServer(dynamicDirectory, port, {
    KOHARU_SUITE_URL: suiteApi.origin,
  });
  const astroOrigin = `http://127.0.0.1:${port}`;
  await waitForHttp(`${astroOrigin}/`, dynamicServer);

  const staticResponse = await fetch(`${astroOrigin}/`);
  assert.equal(staticResponse.status, 200);
  assert.match(await staticResponse.text(), /data-fixture="dynamic-static-page"/u);
  assert.deepEqual(suiteApi.getCalls(), {}, 'Static page unexpectedly called suite');

  const archiveResponse = await fetch(`${astroOrigin}/archive/`);
  assert.equal(archiveResponse.status, 200);
  const archiveBody = await archiveResponse.text();
  assert.match(archiveBody, /Synthetic Koharu Channel/u);
  assert.match(archiveBody, /data-revision="1"/u);
  assert.deepEqual(suiteApi.getCalls(), {
    'GET /api/v1/channels': 1,
    'GET /api/v1/messages': 1,
  });

  const detailResponse = await fetch(`${astroOrigin}/archive/${FIXTURE_MESSAGE_ID}`);
  assert.equal(detailResponse.status, 200);
  const detailBody = await detailResponse.text();
  assert.match(detailBody, /Message revision 1/u);
  assert.match(detailBody, /data-suite-rendered="true"/u);

  suiteApi.setRevision(2);
  const editedResponse = await fetch(`${astroOrigin}/archive/${FIXTURE_MESSAGE_ID}`);
  assert.equal(editedResponse.status, 200);
  assert.match(await editedResponse.text(), /Message revision 2/u);

  const missingResponse = await fetch(
    `${astroOrigin}/archive/019bf895-0e70-7881-83b3-471b8dbb1b34`,
  );
  assert.equal(missingResponse.status, 404);
  assert.match(await missingResponse.text(), /data-state="not-found"/u);

  suiteApi.setMode('http-error');
  const httpErrorResponse = await fetch(`${astroOrigin}/archive/`);
  assert.equal(httpErrorResponse.status, 503);
  assert.match(await httpErrorResponse.text(), /data-state="unavailable"/u);

  suiteApi.setMode('invalid-json');
  const invalidResponse = await fetch(`${astroOrigin}/archive/`);
  assert.equal(invalidResponse.status, 503);
  assert.match(await invalidResponse.text(), /data-state="unavailable"/u);

  suiteApi.setMode('timeout');
  const timeoutResponse = await fetch(`${astroOrigin}/archive/${FIXTURE_MESSAGE_ID}`);
  assert.equal(timeoutResponse.status, 503);
  assert.match(await timeoutResponse.text(), /data-state="unavailable"/u);

  const callsBeforeStaticRecovery = suiteApi.getCalls();
  const stillStaticResponse = await fetch(`${astroOrigin}/`);
  assert.equal(stillStaticResponse.status, 200);
  assert.match(await stillStaticResponse.text(), /data-fixture="dynamic-static-page"/u);
  assert.deepEqual(
    suiteApi.getCalls(),
    callsBeforeStaticRecovery,
    'Static page called suite while the backend was unavailable',
  );

  suiteApi.setMode('ok');
  const recoveredResponse = await fetch(`${astroOrigin}/archive/${FIXTURE_MESSAGE_ID}`);
  assert.equal(recoveredResponse.status, 200);
  assert.match(await recoveredResponse.text(), /Message revision 2/u);

  const calls = suiteApi.getCalls();
  assert.equal(calls['GET /api/v1/channels'], 3);
  assert.equal(calls['GET /api/v1/messages'], 3);
  assert.equal(calls[`GET /api/v1/messages/${FIXTURE_MESSAGE_ID}`], 4);
  assert.equal(calls['GET /api/v1/messages/019bf895-0e70-7881-83b3-471b8dbb1b34'], 1);

  process.stdout.write('Minimal Astro static-off/dynamic-on fixture passed.\n');
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
