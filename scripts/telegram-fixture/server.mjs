import { createServer } from 'node:http';

const port = Number.parseInt(process.env.FIXTURE_PORT ?? '8080', 10);
const channelId = -1002234260754;
const updateId = 9001;
const bot = {
  first_name: 'Koharu Fixture',
  id: 123456789,
  is_bot: true,
  username: 'koharu_fixture_bot',
};
const channel = {
  id: channelId,
  title: 'cos test dev channel backup',
  type: 'channel',
  username: 'cos_test_dev_backup',
};
const update = {
  channel_post: {
    chat: channel,
    date: 1_788_739_200,
    message_id: 42,
    text: 'G1.6 synthetic Compose smoke message',
  },
  update_id: updateId,
};
const calls = new Map();

function json(response, status, body) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

async function requestParameters(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) {
    return {};
  }

  const contentType = request.headers['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    return JSON.parse(body);
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function telegramSuccess(result) {
  return { ok: true, result };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/healthz') {
    json(response, 200, { status: 'ok' });
    return;
  }
  if (url.pathname === '/fixture/state') {
    json(response, 200, {
      calls: Object.fromEntries(
        [...calls.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      updateId,
    });
    return;
  }

  const method = url.pathname.split('/').filter(Boolean).at(-1);
  if (!method || !url.pathname.startsWith('/bot')) {
    json(response, 404, { error: 'not_found' });
    return;
  }

  calls.set(method, (calls.get(method) ?? 0) + 1);
  try {
    const parameters = {
      ...Object.fromEntries(url.searchParams),
      ...(await requestParameters(request)),
    };

    if (method === 'getMe') {
      json(response, 200, telegramSuccess(bot));
      return;
    }
    if (method === 'getChat') {
      json(response, 200, telegramSuccess(channel));
      return;
    }
    if (method === 'getChatMember') {
      json(
        response,
        200,
        telegramSuccess({
          can_delete_messages: true,
          can_edit_messages: true,
          can_manage_chat: true,
          can_post_messages: true,
          status: 'administrator',
          user: bot,
        }),
      );
      return;
    }
    if (method === 'getUpdates') {
      const offset = Number.parseInt(String(parameters.offset ?? '0'), 10);
      if (Number.isFinite(offset) && offset > updateId) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        json(response, 200, telegramSuccess([]));
        return;
      }
      json(response, 200, telegramSuccess([update]));
      return;
    }

    json(response, 404, {
      description: `Fixture does not implement ${method}`,
      error_code: 404,
      ok: false,
    });
  } catch (error) {
    json(response, 400, {
      description: error instanceof Error ? error.message : 'Invalid fixture request',
      error_code: 400,
      ok: false,
    });
  }
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`Telegram fixture listening on ${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
  });
}
