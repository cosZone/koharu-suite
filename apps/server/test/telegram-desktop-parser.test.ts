import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeTelegramDesktopMessage } from '../src/imports/telegram-desktop-normalize.js';
import {
  type DesktopChatDescriptor,
  desktopBareChannelIdToCanonical,
  discoverTelegramDesktopChats,
  matchTelegramDesktopChats,
  streamTelegramDesktopMessages,
  streamTelegramDesktopSelectedMessages,
  TelegramDesktopInputError,
} from '../src/imports/telegram-desktop-parser.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/telegram-desktop/', import.meta.url));

async function collectMessages(inputPath: string, descriptor: DesktopChatDescriptor) {
  const messages = [];
  for await (const item of streamTelegramDesktopMessages(inputPath, descriptor)) {
    if (item.kind === 'record') {
      messages.push(item.record);
    }
  }
  return messages;
}

async function writeLargeExport(inputPath: string, count: number): Promise<void> {
  const output = createWriteStream(inputPath);
  output.write('{"name":"Large","type":"public_channel","id":"1234567890","messages":[');
  for (let index = 0; index < count; index += 1) {
    const separator = index === 0 ? '' : ',';
    if (
      !output.write(
        `${separator}{"id":${index + 1},"type":"message","date_unixtime":"1735787045","text":"message ${index}"}`,
      )
    ) {
      await once(output, 'drain');
    }
  }
  output.end(']}');
  await once(output, 'finish');
}

describe('Telegram Desktop streaming parser', () => {
  it('discovers the single-chat root without materializing messages', async () => {
    const inputPath = path.join(FIXTURES, 'single-channel.json');

    await expect(discoverTelegramDesktopChats(inputPath)).resolves.toEqual([
      {
        id: 1_234_567_890n,
        index: null,
        name: 'Koharu Archive',
        source: 'root',
        type: 'public_channel',
      },
    ]);
  });

  it('discovers chats.list and left_chats.list and streams only the matched descriptor', async () => {
    const inputPath = path.join(FIXTURES, 'account-export.json');
    const descriptors = await discoverTelegramDesktopChats(inputPath);

    expect(descriptors).toEqual([
      {
        id: 1_234_567_890n,
        index: 0,
        name: 'Koharu Archive',
        source: 'chats',
        type: 'public_channel',
      },
      {
        id: 9n,
        index: 1,
        name: 'Private conversation',
        source: 'chats',
        type: 'personal_chat',
      },
      {
        id: 987_654_321n,
        index: 0,
        name: 'Old public archive',
        source: 'left_chats',
        type: 'public_channel',
      },
    ]);

    const [selected] = matchTelegramDesktopChats(descriptors, [-1_001_234_567_890n]);
    if (selected === undefined) {
      throw new Error('Expected the selected chat descriptor');
    }
    await expect(collectMessages(inputPath, selected)).resolves.toEqual([
      expect.objectContaining({ id: '10', text: 'selected' }),
    ]);
  });

  it('streams multiple selected chats in one scan', async () => {
    const inputPath = path.join(FIXTURES, 'account-export.json');
    const descriptors = await discoverTelegramDesktopChats(inputPath);
    const selected = matchTelegramDesktopChats(descriptors, [
      -1_001_234_567_890n,
      -1_000_987_654_321n,
    ]);

    const messages = [];
    for await (const item of streamTelegramDesktopSelectedMessages(inputPath, selected)) {
      if (item.kind === 'record') {
        messages.push({
          id: item.record.id,
          source: item.descriptor.source,
        });
      }
    }
    expect(messages).toEqual([
      { id: '10', source: 'chats' },
      { id: '30', source: 'left_chats' },
    ]);
  });

  it('requires explicit unique public-channel descriptor matches', () => {
    const publicDescriptor: DesktopChatDescriptor = {
      id: 1_234_567_890n,
      index: 0,
      name: 'Archive',
      source: 'chats',
      type: 'public_channel',
    };
    const privateDescriptor: DesktopChatDescriptor = {
      ...publicDescriptor,
      id: 9n,
      index: 1,
      type: 'private_channel',
    };

    expect(() => matchTelegramDesktopChats([publicDescriptor], [])).toThrowError(
      expect.objectContaining({ code: 'missing_channel_selection' }),
    );
    expect(() =>
      matchTelegramDesktopChats([publicDescriptor], [-1_001_234_567_890n, -1_001_234_567_890n]),
    ).toThrowError(expect.objectContaining({ code: 'duplicate_channel_selection' }));
    expect(() =>
      matchTelegramDesktopChats([privateDescriptor], [desktopBareChannelIdToCanonical(9n)]),
    ).toThrowError(expect.objectContaining({ code: 'channel_not_found' }));
    expect(() =>
      matchTelegramDesktopChats(
        [publicDescriptor, { ...publicDescriptor, source: 'left_chats' }],
        [-1_001_234_567_890n],
      ),
    ).toThrowError(expect.objectContaining({ code: 'ambiguous_channel' }));
  });

  it('streams 100k messages with bounded heap growth', { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'koharu-desktop-parser-'));
    const inputPath = path.join(directory, 'result.json');
    try {
      await writeLargeExport(inputPath, 100_000);
      const baseline = process.memoryUsage().heapUsed;
      let peak = baseline;
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      }, 5);
      const [discovered] = await discoverTelegramDesktopChats(inputPath);
      clearInterval(sampler);
      expect(discovered).toMatchObject({
        id: 1_234_567_890n,
        source: 'root',
        type: 'public_channel',
      });
      let count = 0;
      const descriptor: DesktopChatDescriptor = {
        id: 1_234_567_890n,
        index: null,
        name: 'Large',
        source: 'root',
        type: 'public_channel',
      };

      for await (const item of streamTelegramDesktopMessages(inputPath, descriptor)) {
        if (item.kind !== 'record') {
          throw new Error('Generated fixture should contain only message records');
        }
        expect(item.record.id).toBe(String(count + 1));
        count += 1;
        if (count % 5_000 === 0) {
          peak = Math.max(peak, process.memoryUsage().heapUsed);
        }
      }

      expect(count).toBe(100_000);
      expect(peak - baseline).toBeLessThan(128 * 1_024 * 1_024);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('preserves integer lexemes beyond Number.MAX_SAFE_INTEGER', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'koharu-desktop-parser-'));
    const inputPath = path.join(directory, 'result.json');
    try {
      const output = createWriteStream(inputPath);
      output.end(
        '{"name":"Large ID","type":"public_channel","id":9007199254740993,"messages":[{"id":9007199254740995,"type":"message","date_unixtime":1735787045,"text":"exact"}]}',
      );
      await once(output, 'finish');

      const [descriptor] = await discoverTelegramDesktopChats(inputPath);
      expect(descriptor?.id).toBe(9_007_199_254_740_993n);
      if (!descriptor) {
        throw new Error('Expected descriptor');
      }
      const items = [];
      for await (const item of streamTelegramDesktopMessages(inputPath, descriptor)) {
        items.push(item);
      }
      expect(items).toMatchObject([
        {
          kind: 'record',
          record: {
            date_unixtime: '1735787045',
            id: '9007199254740995',
          },
        },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('reports malformed message elements as item errors and continues', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'koharu-desktop-parser-'));
    const inputPath = path.join(directory, 'result.json');
    try {
      const output = createWriteStream(inputPath);
      output.end(
        '{"name":"Malformed","type":"public_channel","id":1234567890,"messages":[{"id":1,"type":"message","date_unixtime":"1735787045","text":"before"},null,{"id":2,"type":"message","date_unixtime":"1735787046","text":"after"}]}',
      );
      await once(output, 'finish');

      const [descriptor] = await discoverTelegramDesktopChats(inputPath);
      if (!descriptor) {
        throw new Error('Expected descriptor');
      }
      const items = [];
      for await (const item of streamTelegramDesktopMessages(inputPath, descriptor)) {
        items.push(item);
      }
      expect(items.map((item) => item.kind)).toEqual(['record', 'item_error', 'record']);
      expect(items[2]).toMatchObject({ kind: 'record', record: { id: '2', text: 'after' } });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('recognizes the official rich_message shape as unsupported rather than invalid', async () => {
    const inputPath = path.join(FIXTURES, 'rich-message.json');
    const [descriptor] = await discoverTelegramDesktopChats(inputPath);
    if (!descriptor) {
      throw new Error('Expected descriptor');
    }
    for await (const item of streamTelegramDesktopMessages(inputPath, descriptor)) {
      if (item.kind !== 'record') {
        throw new Error('Expected a rich message record');
      }
      expect(
        normalizeTelegramDesktopMessage(item.record, {
          channel: {
            telegramChatId: desktopBareChannelIdToCanonical(descriptor.id),
            title: descriptor.name,
            username: null,
          },
          sourceChatId: descriptor.id,
        }),
      ).toEqual({ kind: 'skipped', reason: 'rich_message' });
    }
  });

  it('reports malformed JSON without exposing parser internals', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'koharu-desktop-parser-'));
    const inputPath = path.join(directory, 'result.json');
    try {
      const output = createWriteStream(inputPath);
      output.end('{"messages": [');
      await once(output, 'finish');

      await expect(discoverTelegramDesktopChats(inputPath)).rejects.toBeInstanceOf(
        TelegramDesktopInputError,
      );
      await expect(discoverTelegramDesktopChats(inputPath)).rejects.toMatchObject({
        code: 'invalid_json',
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
