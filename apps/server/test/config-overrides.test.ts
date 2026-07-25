import { afterEach, describe, expect, it, vi } from 'vitest';

const { clientMock, postgresMock } = vi.hoisted(() => {
  const client = Object.assign(vi.fn(), { end: vi.fn(async () => undefined) });
  return { clientMock: client, postgresMock: vi.fn(() => client) };
});

vi.mock('postgres', () => ({ default: postgresMock }));

import { loadConfigOverrides, readConfigOverrides } from '../src/config-overrides.js';

const DATABASE_URL = 'postgresql://koharu:koharu@localhost:5432/koharu';

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('loadConfigOverrides', () => {
  it('returns the stored overrides as an environment map', async () => {
    clientMock.mockResolvedValueOnce([
      { key: 'S3_REGION', value: 'eu-west-1' },
      { key: 'TRUST_PROXY', value: 'true' },
    ]);

    await expect(loadConfigOverrides(DATABASE_URL)).resolves.toEqual({
      S3_REGION: 'eu-west-1',
      TRUST_PROXY: 'true',
    });
    expect(postgresMock).toHaveBeenCalledWith(DATABASE_URL, { max: 1 });
    expect(clientMock.end).toHaveBeenCalledOnce();
  });

  it('drops rows whose keys are not panel-configurable', async () => {
    clientMock.mockResolvedValueOnce([
      { key: 'S3_REGION', value: 'eu-west-1' },
      { key: 'TELEGRAM_BOT_TOKEN', value: 'manual-insert' },
      { key: 'BETTER_AUTH_SECRET', value: 'manual-insert' },
    ]);

    await expect(loadConfigOverrides(DATABASE_URL)).resolves.toEqual({
      S3_REGION: 'eu-west-1',
    });
    expect(clientMock.end).toHaveBeenCalledOnce();
  });

  it('treats a missing config_overrides table as no overrides', async () => {
    clientMock.mockRejectedValueOnce(
      Object.assign(new Error('relation "config_overrides" does not exist'), { code: '42P01' }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(loadConfigOverrides(DATABASE_URL)).resolves.toEqual({});
    expect(warn).not.toHaveBeenCalled();
    expect(clientMock.end).toHaveBeenCalledOnce();
  });

  it('degrades to no overrides with a warning when the read fails', async () => {
    clientMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(loadConfigOverrides(DATABASE_URL)).resolves.toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(clientMock.end).toHaveBeenCalledOnce();
  });

  it('reports the read failure to the doctor without failing startup', async () => {
    clientMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5432'));

    const result = await readConfigOverrides(DATABASE_URL);
    expect(result.overrides).toEqual({});
    expect(result.readError).toContain('ECONNREFUSED');
  });
});
