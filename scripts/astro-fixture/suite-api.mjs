import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const FIXTURE_CHANNEL_ID = '019bf894-2b6c-7b18-bd70-0ad6349a4af1';
export const FIXTURE_MESSAGE_ID = '019bf895-0e70-7881-83b3-471b8dbb1b33';

const channel = {
  id: FIXTURE_CHANNEL_ID,
  title: 'Synthetic Koharu Channel',
  username: 'synthetic_koharu',
};

function fixtureMessage(revision) {
  return {
    authorSignature: 'Fixture',
    channel,
    content: {
      entities: [],
      html: `<p data-suite-rendered="true">Synthetic revision ${revision}</p>`,
      kind: 'text',
      text: `Synthetic revision ${revision}`,
    },
    id: FIXTURE_MESSAGE_ID,
    media: [],
    mediaGroupId: null,
    publishedAt: '2026-07-24T00:00:00.000Z',
    revision,
    sourceUrl: 'https://t.me/synthetic_koharu/42',
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

export async function startSuiteApiFixture(options = {}) {
  const calls = new Map();
  let revision = 1;
  let mode = options.failOnApiRequest ? 'http-error' : 'ok';

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (url.pathname === '/__fixture/state') {
      sendJson(response, 200, {
        calls: Object.fromEntries([...calls.entries()].sort()),
        mode,
        revision,
      });
      return;
    }

    if (!url.pathname.startsWith('/api/v1/')) {
      sendJson(response, 404, { error: { code: 'not_found', message: 'Not found' } });
      return;
    }

    const callKey = `${request.method ?? 'GET'} ${url.pathname}`;
    calls.set(callKey, (calls.get(callKey) ?? 0) + 1);

    if (mode === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (mode === 'invalid-json') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end('{invalid');
      return;
    }
    if (mode === 'http-error') {
      sendJson(response, 503, {
        error: { code: 'fixture_unavailable', message: 'Synthetic fixture unavailable' },
      });
      return;
    }

    if (url.pathname === '/api/v1/channels') {
      sendJson(response, 200, { items: [channel] });
      return;
    }

    if (url.pathname === '/api/v1/messages') {
      if (url.searchParams.get('channel') !== FIXTURE_CHANNEL_ID) {
        sendJson(response, 404, {
          error: { code: 'channel_not_found', message: 'Channel was not found' },
        });
        return;
      }
      sendJson(response, 200, { items: [fixtureMessage(revision)], nextCursor: null });
      return;
    }

    if (url.pathname === `/api/v1/messages/${FIXTURE_MESSAGE_ID}`) {
      sendJson(response, 200, fixtureMessage(revision));
      return;
    }

    if (url.pathname.startsWith('/api/v1/messages/')) {
      sendJson(response, 404, {
        error: { code: 'message_not_found', message: 'Message was not found' },
      });
      return;
    }

    sendJson(response, 404, { error: { code: 'not_found', message: 'Not found' } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Suite API fixture did not bind a TCP port');
  }

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    getCalls: () => Object.fromEntries([...calls.entries()].sort()),
    origin: `http://127.0.0.1:${address.port}`,
    setMode(nextMode) {
      mode = nextMode;
    },
    setRevision(nextRevision) {
      revision = nextRevision;
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const fixture = await startSuiteApiFixture({
    failOnApiRequest: process.env.KOHARU_FIXTURE_FAIL_ON_REQUEST === 'true',
  });
  process.stdout.write(`${JSON.stringify({ origin: fixture.origin })}\n`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await fixture.close();
      process.exitCode = 0;
    });
  }
}
