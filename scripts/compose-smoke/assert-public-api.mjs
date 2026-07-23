import assert from 'node:assert/strict';

const origin = process.env.KOHARU_SMOKE_ORIGIN ?? 'http://127.0.0.1:39000';
const expectedText = 'G1.6 synthetic Compose smoke message';
const deadline = Date.now() + 30_000;

async function fetchJson(path) {
  const response = await fetch(`${origin}${path}`);
  assert.equal(response.ok, true, `${path} returned ${response.status}`);
  return response.json();
}

let lastError;
while (Date.now() < deadline) {
  try {
    const channels = await fetchJson('/api/v1/channels');
    assert.equal(channels.items.length, 1, 'exactly one fixture channel should be public');
    assert.equal(channels.items[0].title, 'cos test dev channel backup');
    assert.equal(channels.items[0].username, 'cos_test_dev_backup');

    const messages = await fetchJson(
      `/api/v1/messages?channel=${encodeURIComponent(channels.items[0].id)}&limit=10`,
    );
    assert.equal(messages.items.length, 1, 'exactly one fixture message should be archived');
    assert.equal(messages.items[0].content.text, expectedText);
    assert.equal(messages.items[0].channel.id, channels.items[0].id);

    const message = await fetchJson(`/api/v1/messages/${messages.items[0].id}`);
    assert.equal(message.id, messages.items[0].id);
    assert.equal(message.content.text, expectedText);
    process.stdout.write('Public API contains the synthetic Telegram fixture message.\n');
    process.exit(0);
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

throw lastError ?? new Error('Timed out waiting for the fixture message');
