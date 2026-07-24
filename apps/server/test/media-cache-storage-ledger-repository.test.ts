import { describe, expect, it } from 'vitest';
import {
  createStorageBackendConfigFingerprint,
  type S3StorageBackendConfig,
} from '../src/media-cache/storage-ledger-repository.js';

describe('storage backend config fingerprint', () => {
  it('is deterministic regardless of property insertion order', () => {
    const config: S3StorageBackendConfig = {
      bucket: 'archive',
      endpointOrigin: 'https://s3.example.com',
      forcePathStyle: false,
      maxBytes: 5_368_709_120n,
      prefix: 'koharu/media',
      region: 'auto',
    };
    const reordered: S3StorageBackendConfig = {
      region: 'auto',
      prefix: 'koharu/media',
      maxBytes: 5_368_709_120n,
      forcePathStyle: false,
      endpointOrigin: 'https://s3.example.com',
      bucket: 'archive',
    };

    expect(createStorageBackendConfigFingerprint({ ...config, kind: 's3' })).toBe(
      '1b2e5802733096b5ee235c74de69fc0e6c9cecaf101a35aee6382017865f5744',
    );
    expect(createStorageBackendConfigFingerprint({ ...reordered, kind: 's3' })).toBe(
      createStorageBackendConfigFingerprint({ ...config, kind: 's3' }),
    );
    expect(
      createStorageBackendConfigFingerprint({
        ...config,
        kind: 's3',
        maxBytes: 1n,
      }),
    ).toBe(createStorageBackendConfigFingerprint({ ...config, kind: 's3' }));
    expect(
      createStorageBackendConfigFingerprint({
        kind: 'local',
        maxBytes: 1n,
        root: '/var/lib/koharu/media',
      }),
    ).toBe(
      createStorageBackendConfigFingerprint({
        kind: 'local',
        maxBytes: 9_999n,
        root: '/var/lib/koharu/media',
      }),
    );
  });

  it('does not accept or fingerprint credentials', () => {
    const config: S3StorageBackendConfig = {
      bucket: 'archive',
      endpointOrigin: 'https://s3.example.com',
      forcePathStyle: false,
      maxBytes: 5_368_709_120n,
      prefix: 'koharu/media',
      region: 'auto',
    };
    const fingerprint = createStorageBackendConfigFingerprint({ ...config, kind: 's3' });
    const untrustedRuntimeInput = {
      ...config,
      key: 'access-key-must-not-be-fingerprinted',
      kind: 's3' as const,
      secret: 'secret-must-not-be-fingerprinted',
    };

    expect(createStorageBackendConfigFingerprint(untrustedRuntimeInput)).toBe(fingerprint);
    expect(() =>
      createStorageBackendConfigFingerprint({
        ...config,
        endpointOrigin: 'https://key:secret@s3.example.com',
        kind: 's3',
      }),
    ).toThrow('S3 endpoint must be a canonical HTTP or HTTPS origin');
  });
});
