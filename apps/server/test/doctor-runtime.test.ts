import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.js';
import { PostgresDoctorDiagnostics, TelegramDoctorDiagnostics } from '../src/ops/doctor-runtime.js';
import type { TelegramApi } from '../src/telegram/api.js';

describe('doctor runtime adapters', () => {
  it('checks migration tables and required columns without interpolating object names', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        { schemaName: 'public', tableName: 'auth_users' },
        { schemaName: 'public', tableName: 'auth_api_keys' },
        { schemaName: 'drizzle', tableName: '__drizzle_migrations' },
      ])
      .mockResolvedValueOnce([
        {
          columnName: 'enabled',
          schemaName: 'public',
          tableName: 'auth_api_keys',
        },
      ])
      .mockResolvedValueOnce([
        {
          constraintName: 'auth_api_keys_key_unique',
          schemaName: 'public',
        },
      ]);
    const diagnostics = new PostgresDoctorDiagnostics({
      execute,
    } as unknown as Database);

    await expect(
      diagnostics.listMissingSchemaObjects([
        'auth_users',
        'auth_api_keys',
        'auth_api_keys.enabled',
        'auth_api_keys.permissions',
        'drizzle.__drizzle_migrations',
        'constraint:public.auth_api_keys_key_unique',
        'constraint:public.auth_api_keys_missing_check',
      ]),
    ).resolves.toEqual([
      'auth_api_keys.permissions',
      'constraint:public.auth_api_keys_missing_check',
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
    for (const [query] of execute.mock.calls) {
      expect(JSON.stringify(query)).not.toContain('auth_api_keys.permissions');
    }
  });

  it('exposes only read-only Telegram diagnostics and never polls updates', async () => {
    const api = {
      getChat: vi.fn(async () => ({
        id: -1_001,
        title: 'channel',
        type: 'channel' as const,
        username: 'channel',
      })),
      getChatMember: vi.fn(async () => ({
        status: 'administrator' as const,
        user: {
          first_name: 'Kodama',
          id: 123,
          is_bot: true,
        },
      })),
      getMe: vi.fn(async () => ({
        can_connect_to_business: false,
        can_join_groups: true,
        can_read_all_group_messages: false,
        first_name: 'Kodama',
        has_main_web_app: false,
        id: 123,
        is_bot: true,
        supports_inline_queries: false,
        username: 'kodama_bot',
      })),
      getUpdates: vi.fn(),
    };
    const diagnostics = new TelegramDoctorDiagnostics(api as unknown as TelegramApi);

    await expect(diagnostics.getMe()).resolves.toEqual({
      id: 123,
      username: 'kodama_bot',
    });
    await expect(diagnostics.getChat(-1_001)).resolves.toMatchObject({
      id: -1_001,
      type: 'channel',
      username: 'channel',
    });
    await expect(diagnostics.getChatMember(-1_001, 123)).resolves.toEqual({
      status: 'administrator',
    });
    expect('getUpdates' in diagnostics).toBe(false);
    expect(api.getUpdates).not.toHaveBeenCalled();
  });
});
