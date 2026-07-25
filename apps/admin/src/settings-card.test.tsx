import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ConfigSettingsCard,
  configPendingChanges,
  configSettingInitialValues,
} from './components/desk/browse/settings';
import type { AdminConfigResponse } from './lib/types';

const basicConfig: AdminConfigResponse = {
  sections: [
    {
      id: 'media_cache',
      label: '媒体缓存',
      settings: [
        {
          description: '是否启用本地媒体缓存；S3 存储依赖媒体缓存。',
          effective: 'true',
          envName: 'MEDIA_CACHE_ENABLED',
          kind: 'boolean',
          label: '启用媒体缓存',
          locked: false,
          pendingRestart: false,
          secret: false,
          source: 'default',
        },
        {
          description: '本地缓存根目录的绝对路径。',
          effective: '/var/lib/koharu/media-cache',
          envName: 'MEDIA_CACHE_ROOT',
          kind: 'string',
          label: '缓存根目录',
          locked: true,
          pendingRestart: false,
          secret: false,
          source: 'explicit_env',
        },
        {
          description: '本地缓存可使用的最大字节数。',
          effective: '1073741824',
          envName: 'MEDIA_CACHE_MAX_BYTES',
          kind: 'number',
          label: '缓存容量上限（字节）',
          locked: false,
          pendingRestart: true,
          pendingValue: '2147483648',
          secret: false,
          source: 'override',
        },
      ],
    },
    {
      id: 's3',
      label: 'S3 存储',
      settings: [
        {
          description: 'S3 兼容服务的 HTTP/HTTPS 端点。',
          effective: null,
          envName: 'S3_ENDPOINT',
          kind: 'string',
          label: 'S3 端点',
          locked: false,
          pendingRestart: false,
          secret: false,
          source: 'default',
        },
        {
          description: 'S3 访问密钥 Secret；只写，保存后不回显。',
          effective: { last4: 'wxyz', set: true },
          envName: 'S3_SECRET',
          kind: 'secret',
          label: '访问密钥 Secret',
          locked: false,
          pendingRestart: false,
          secret: true,
          source: 'override',
        },
      ],
    },
    {
      id: 'public_api',
      label: '公开 API',
      settings: [
        {
          description: '每个限流窗口内单个来源允许的最大请求数。',
          effective: '120',
          envName: 'PUBLIC_RATE_LIMIT_MAX',
          kind: 'number',
          label: '限流阈值',
          locked: false,
          pendingRestart: false,
          secret: false,
          source: 'default',
        },
      ],
    },
    {
      id: 'ingestion',
      label: '采集',
      settings: [
        {
          description: 'Telegram 采集工作进程的并发数（1-16）。',
          effective: '4',
          envName: 'TELEGRAM_WORKER_CONCURRENCY',
          kind: 'number',
          label: '采集并发数',
          locked: false,
          pendingRestart: false,
          secret: false,
          source: 'default',
        },
      ],
    },
  ],
};

function renderSettings(overrides: Partial<Parameters<typeof ConfigSettingsCard>[0]> = {}) {
  return renderToStaticMarkup(
    <ConfigSettingsCard
      busyAction={null}
      config={basicConfig}
      onReasonChange={vi.fn()}
      onSave={vi.fn()}
      reasons={{}}
      {...overrides}
    />,
  );
}

describe('ConfigSettingsCard', () => {
  it('renders the four registry sections with per-kind controls', () => {
    const markup = renderSettings();

    expect(markup).toContain('媒体缓存');
    expect(markup).toContain('S3 存储');
    expect(markup).toContain('公开 API');
    expect(markup).toContain('采集');
    expect(markup).toContain('data-slot="switch"');
    expect(markup).toContain('变更原因（必填，将写入审计记录）');
    expect(markup).toContain('保存配置变更');
  });

  it('disables locked inputs and explains the explicit env lock', () => {
    const markup = renderSettings();

    expect(markup).toContain('由环境变量锁定');
    expect(markup).toMatch(/<input[^>]*disabled=""[^>]*value="\/var\/lib\/koharu\/media-cache"/);
  });

  it('shows the restart badge and the pending value for overridden settings', () => {
    const markup = renderSettings();

    expect(markup).toContain('重启后生效');
    expect(markup).toContain('value="2147483648"');
    expect(markup).not.toContain('value="1073741824"');
    // 仅有覆盖的项(MEDIA_CACHE_MAX_BYTES、S3_SECRET)渲染清除按钮
    expect(markup.match(/>清除</g)).toHaveLength(2);
  });

  it('renders secrets as empty password inputs without echoing masked values', () => {
    const markup = renderSettings();

    expect(markup).toMatch(/type="password"[^>]*value=""/);
    expect(markup).toContain('已配置（留空保持不变）');
    expect(markup).not.toContain('wxyz');
  });

  it('keeps submit disabled without a reason or without edits', () => {
    const withoutReason = renderSettings();
    expect(withoutReason).toMatch(/<button[^>]*disabled=""[^>]*>保存配置变更<\/button>/);

    const withReason = renderSettings({ reasons: { 'config-save': '启用 S3 耐久副本' } });
    expect(withReason).toMatch(/<button[^>]*disabled=""[^>]*>保存配置变更<\/button>/);
  });
});

describe('configSettingInitialValues', () => {
  it('prefers pending values and never seeds secrets', () => {
    const values = configSettingInitialValues(basicConfig);

    expect(values.MEDIA_CACHE_MAX_BYTES).toBe('2147483648');
    expect(values.MEDIA_CACHE_ENABLED).toBe('true');
    expect(values.S3_ENDPOINT).toBe('');
    expect(values.S3_SECRET).toBe('');
  });
});

describe('configPendingChanges', () => {
  const noClears = new Set<string>();

  it('omits unchanged fields, including untouched empty secrets', () => {
    const result = configPendingChanges(
      basicConfig,
      configSettingInitialValues(basicConfig),
      noClears,
    );

    expect(result.changes).toEqual({});
    expect(result.errors).toEqual({});
    expect(result.editCount).toBe(0);
    expect(result.changes).not.toHaveProperty('S3_SECRET');
  });

  it('includes a secret only when a new value was typed', () => {
    const values = { ...configSettingInitialValues(basicConfig), S3_SECRET: 'new-secret-value' };

    const result = configPendingChanges(basicConfig, values, noClears);

    expect(result.changes).toEqual({ S3_SECRET: 'new-secret-value' });
  });

  it('maps cleared keys to null and lets clear win over a typed value', () => {
    const values = { ...configSettingInitialValues(basicConfig), S3_SECRET: 'ignored' };

    const result = configPendingChanges(basicConfig, values, new Set(['S3_SECRET']));

    expect(result.changes).toEqual({ S3_SECRET: null });
    expect(result.editCount).toBe(1);
  });

  it('serializes boolean edits as true/false strings', () => {
    const values = {
      ...configSettingInitialValues(basicConfig),
      MEDIA_CACHE_ENABLED: 'false',
    };

    const result = configPendingChanges(basicConfig, values, noClears);

    expect(result.changes).toEqual({ MEDIA_CACHE_ENABLED: 'false' });
  });

  it('excludes invalid numbers from changes and reports a field error', () => {
    const values = {
      ...configSettingInitialValues(basicConfig),
      PUBLIC_RATE_LIMIT_MAX: 'abc',
      TELEGRAM_WORKER_CONCURRENCY: '8',
    };

    const result = configPendingChanges(basicConfig, values, noClears);

    expect(result.changes).toEqual({ TELEGRAM_WORKER_CONCURRENCY: '8' });
    expect(result.errors).toEqual({ PUBLIC_RATE_LIMIT_MAX: '请输入非负整数。' });
    expect(result.editCount).toBe(2);
  });
});
