import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURE_MESSAGE_ID, startSuiteApiFixture } from './suite-api.mjs';
import {
  createTemporaryDirectory,
  getFreePort,
  packKoharuAstro,
  prepareConsumerFixture,
  removeTemporaryDirectory,
  repositoryRoot,
  runCommand,
  startAstroServer,
  stopAstroServer,
  waitForHttp,
} from './support.mjs';

const versions = [
  { astro: '6.4.8', label: 'Astro 6', nodeAdapter: '10.1.4', slug: 'astro-6' },
  { astro: '7.1.3', label: 'Astro 7', nodeAdapter: '11.0.2', slug: 'astro-7' },
];
const fixtureRoot = join(repositoryRoot, 'tests/fixtures/astro-consumer');
const temporaryRoot = await createTemporaryDirectory('koharu-astro-fixture-');
const artifacts = join(temporaryRoot, 'artifacts');

async function testVersion(version, tarball) {
  const staticDirectory = join(temporaryRoot, `${version.slug}-static-off`);
  const dynamicDirectory = join(temporaryRoot, `${version.slug}-dynamic-on`);
  const staticReplacements = { __ASTRO_VERSION__: version.astro };
  const dynamicReplacements = {
    ...staticReplacements,
    __ASTRO_NODE_VERSION__: version.nodeAdapter,
  };

  let dynamicServer;
  let suiteApi;
  let trapApi;

  try {
    trapApi = await startSuiteApiFixture({ failOnApiRequest: true });
    await prepareConsumerFixture(
      join(fixtureRoot, 'static-off'),
      staticDirectory,
      tarball,
      staticReplacements,
    );
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
    assert.deepEqual(trapApi.getCalls(), {}, `${version.label} static-off build called suite`);
    await trapApi.close();
    trapApi = undefined;

    suiteApi = await startSuiteApiFixture();
    await prepareConsumerFixture(
      join(fixtureRoot, 'dynamic-on'),
      dynamicDirectory,
      tarball,
      dynamicReplacements,
    );
    await runCommand('pnpm', ['exec', 'astro', 'check'], {
      cwd: dynamicDirectory,
      env: { KOHARU_SUITE_URL: suiteApi.origin },
    });
    assert.deepEqual(suiteApi.getCalls(), {}, `${version.label} check fetched live content`);
    await runCommand('pnpm', ['exec', 'astro', 'build'], {
      cwd: dynamicDirectory,
      env: { KOHARU_SUITE_URL: suiteApi.origin },
    });
    await access(join(dynamicDirectory, 'dist/server/entry.mjs'));
    assert.deepEqual(suiteApi.getCalls(), {}, `${version.label} build fetched live content`);

    const port = await getFreePort();
    dynamicServer = startAstroServer(dynamicDirectory, port, {
      KOHARU_SUITE_URL: suiteApi.origin,
    });
    const astroOrigin = `http://127.0.0.1:${port}`;
    await waitForHttp(`${astroOrigin}/`, dynamicServer);

    const staticResponse = await fetch(`${astroOrigin}/`);
    assert.equal(staticResponse.status, 200);
    assert.match(await staticResponse.text(), /data-fixture="dynamic-static-page"/u);
    assert.deepEqual(suiteApi.getCalls(), {}, `${version.label} static page called suite`);

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

    const contractResponse = await fetch(`${astroOrigin}/archive/contracts`);
    assert.equal(contractResponse.status, 200);
    const contractBody = await contractResponse.text();
    assert.match(contractBody, new RegExp(`data-latest-message="${FIXTURE_MESSAGE_ID}"`, 'u'));
    assert.match(contractBody, new RegExp(`data-context-message="${FIXTURE_MESSAGE_ID}"`, 'u'));
    assert.match(contractBody, /data-newer="019bf895-0e70-7881-83b3-471b8dbb1b37"/u);
    assert.match(contractBody, /data-older="019bf895-0e70-7881-83b3-471b8dbb1b38"/u);
    assert.match(contractBody, /Synthetic newer preview/u);
    assert.match(contractBody, /No older preview/u);

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
      `${version.label} static page called suite while unavailable`,
    );

    suiteApi.setMode('ok');
    const recoveredResponse = await fetch(`${astroOrigin}/archive/${FIXTURE_MESSAGE_ID}`);
    assert.equal(recoveredResponse.status, 200);
    assert.match(await recoveredResponse.text(), /Message revision 2/u);

    const calls = suiteApi.getCalls();
    assert.equal(calls['GET /api/v1/channels'], 3);
    assert.equal(calls['GET /api/v1/messages'], 3);
    assert.equal(calls['GET /api/v1/messages/latest'], 1);
    assert.equal(calls[`GET /api/v1/messages/${FIXTURE_MESSAGE_ID}/context`], 1);
    assert.equal(calls[`GET /api/v1/messages/${FIXTURE_MESSAGE_ID}`], 4);
    assert.equal(calls['GET /api/v1/messages/019bf895-0e70-7881-83b3-471b8dbb1b34'], 1);

    process.stdout.write(`${version.label} static-off/dynamic-on fixture passed.\n`);
  } finally {
    if (dynamicServer) {
      await stopAstroServer(dynamicServer).catch(() => {
        dynamicServer.child.kill('SIGKILL');
      });
    }
    await suiteApi?.close().catch(() => {});
    await trapApi?.close().catch(() => {});
  }
}

try {
  await mkdir(artifacts);
  const tarball = await packKoharuAstro(artifacts);
  for (const version of versions) {
    await testVersion(version, tarball);
  }
} finally {
  await removeTemporaryDirectory(temporaryRoot);
}
