import type { z } from 'zod';
import {
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_S3_DEFAULT_MAX_BYTES,
  mediaCacheEnvironmentSchema,
  mediaS3EnvironmentSchema,
  publicApiEnvironmentSchema,
  telegramEnvironmentSchema,
} from './config.js';

export type ConfigSection = 'ingestion' | 'media_cache' | 'public_api' | 's3';
export type ConfigSettingKind = 'boolean' | 'number' | 'secret' | 'string';
export type ConfigValueSource = 'default' | 'explicit_env' | 'override';

export interface ConfigurableSetting {
  /** Serialized default ('' means unset). */
  defaultValue: string;
  description: string;
  envName: string;
  kind: ConfigSettingKind;
  label: string;
  schema: z.ZodType<unknown>;
  secret: boolean;
  section: ConfigSection;
}

export const CONFIG_SECTION_LABELS: Record<ConfigSection, string> = {
  ingestion: '采集',
  media_cache: '媒体缓存',
  public_api: '公开 API',
  s3: 'S3 存储',
};

export const CONFIGURABLE_SETTINGS: readonly ConfigurableSetting[] = [
  {
    defaultValue: 'false',
    description: '是否启用本地媒体缓存；S3 存储依赖媒体缓存。',
    envName: 'MEDIA_CACHE_ENABLED',
    kind: 'boolean',
    label: '启用媒体缓存',
    schema: mediaCacheEnvironmentSchema.shape.MEDIA_CACHE_ENABLED,
    secret: false,
    section: 'media_cache',
  },
  {
    defaultValue: '/var/lib/koharu/media-cache',
    description: '本地缓存根目录的绝对路径；仅修改路径，不会搬移已有缓存，容器内需确保路径已挂载。',
    envName: 'MEDIA_CACHE_ROOT',
    kind: 'string',
    label: '缓存根目录',
    schema: mediaCacheEnvironmentSchema.shape.MEDIA_CACHE_ROOT,
    secret: false,
    section: 'media_cache',
  },
  {
    defaultValue: String(MEDIA_CACHE_MAX_BYTES),
    description: '本地缓存可使用的最大字节数。',
    envName: 'MEDIA_CACHE_MAX_BYTES',
    kind: 'number',
    label: '缓存容量上限（字节）',
    schema: mediaCacheEnvironmentSchema.shape.MEDIA_CACHE_MAX_BYTES,
    secret: false,
    section: 'media_cache',
  },
  {
    defaultValue: '2',
    description: '媒体缓存下载的并发任务数（1-4）。',
    envName: 'MEDIA_CACHE_DOWNLOAD_CONCURRENCY',
    kind: 'number',
    label: '下载并发数',
    schema: mediaCacheEnvironmentSchema.shape.MEDIA_CACHE_DOWNLOAD_CONCURRENCY,
    secret: false,
    section: 'media_cache',
  },
  {
    defaultValue: '',
    description: 'S3 兼容服务的 HTTP/HTTPS 端点；变更端点前需先完成已有数据迁移。',
    envName: 'S3_ENDPOINT',
    kind: 'string',
    label: 'S3 端点',
    schema: mediaS3EnvironmentSchema.shape.S3_ENDPOINT,
    secret: false,
    section: 's3',
  },
  {
    defaultValue: '',
    description: 'S3 存储桶名称；变更存储桶前需先完成已有数据迁移。',
    envName: 'S3_BUCKET',
    kind: 'string',
    label: '存储桶',
    schema: mediaS3EnvironmentSchema.shape.S3_BUCKET,
    secret: false,
    section: 's3',
  },
  {
    defaultValue: 'us-east-1',
    description: 'S3 区域。',
    envName: 'S3_REGION',
    kind: 'string',
    label: '区域',
    schema: mediaS3EnvironmentSchema.shape.S3_REGION,
    secret: false,
    section: 's3',
  },
  {
    defaultValue: 'koharu/media-cache',
    description: '缓存对象在存储桶内的键前缀；变更前缀前需先完成已有数据迁移。',
    envName: 'S3_PREFIX',
    kind: 'string',
    label: '对象键前缀',
    schema: mediaS3EnvironmentSchema.shape.S3_PREFIX,
    secret: false,
    section: 's3',
  },
  {
    defaultValue: String(MEDIA_S3_DEFAULT_MAX_BYTES),
    description: 'S3 后端可使用的最大字节数。',
    envName: 'S3_MAX_BYTES',
    kind: 'number',
    label: 'S3 容量上限（字节）',
    schema: mediaS3EnvironmentSchema.shape.S3_MAX_BYTES,
    secret: false,
    section: 's3',
  },
  {
    defaultValue: 'true',
    description: '使用 path-style 寻址（大多数 S3 兼容服务需要）。',
    envName: 'S3_FORCE_PATH_STYLE',
    kind: 'boolean',
    label: '强制路径风格',
    schema: mediaS3EnvironmentSchema.shape.S3_FORCE_PATH_STYLE,
    secret: false,
    section: 's3',
  },
  {
    defaultValue: 'false',
    description: '允许使用不加密的 HTTP S3 端点。',
    envName: 'S3_ALLOW_INSECURE',
    kind: 'boolean',
    label: '允许 HTTP 端点',
    schema: mediaS3EnvironmentSchema.shape.S3_ALLOW_INSECURE,
    secret: false,
    section: 's3',
  },
  {
    defaultValue: '5000',
    description: 'S3 连接超时时间（毫秒）。',
    envName: 'S3_CONNECT_TIMEOUT_MS',
    kind: 'number',
    label: '连接超时（毫秒）',
    schema: mediaS3EnvironmentSchema.shape.S3_CONNECT_TIMEOUT_MS,
    secret: false,
    section: 's3',
  },
  {
    defaultValue: '30000',
    description: 'S3 单次请求超时时间（毫秒）。',
    envName: 'S3_REQUEST_TIMEOUT_MS',
    kind: 'number',
    label: '请求超时（毫秒）',
    schema: mediaS3EnvironmentSchema.shape.S3_REQUEST_TIMEOUT_MS,
    secret: false,
    section: 's3',
  },
  {
    defaultValue: '',
    description: 'S3 访问密钥 ID；只写，保存后不回显。',
    envName: 'S3_KEY',
    kind: 'secret',
    label: '访问密钥 ID',
    schema: mediaS3EnvironmentSchema.shape.S3_KEY,
    secret: true,
    section: 's3',
  },
  {
    defaultValue: '',
    description: 'S3 访问密钥 Secret；只写，保存后不回显。',
    envName: 'S3_SECRET',
    kind: 'secret',
    label: '访问密钥 Secret',
    schema: mediaS3EnvironmentSchema.shape.S3_SECRET,
    secret: true,
    section: 's3',
  },
  {
    defaultValue: '',
    description: '逗号分隔的允许跨域来源；留空则不开启 CORS。',
    envName: 'PUBLIC_CORS_ORIGINS',
    kind: 'string',
    label: 'CORS 允许来源',
    schema: publicApiEnvironmentSchema.shape.PUBLIC_CORS_ORIGINS,
    secret: false,
    section: 'public_api',
  },
  {
    defaultValue: '120',
    description: '每个限流窗口内单个来源允许的最大请求数。',
    envName: 'PUBLIC_RATE_LIMIT_MAX',
    kind: 'number',
    label: '限流阈值',
    schema: publicApiEnvironmentSchema.shape.PUBLIC_RATE_LIMIT_MAX,
    secret: false,
    section: 'public_api',
  },
  {
    defaultValue: '60',
    description: '公开 API 限流窗口长度（秒）。',
    envName: 'PUBLIC_RATE_LIMIT_WINDOW_SECONDS',
    kind: 'number',
    label: '限流窗口（秒）',
    schema: publicApiEnvironmentSchema.shape.PUBLIC_RATE_LIMIT_WINDOW_SECONDS,
    secret: false,
    section: 'public_api',
  },
  {
    defaultValue: 'false',
    description: '启用后从 X-Forwarded-For 读取客户端地址。',
    envName: 'TRUST_PROXY',
    kind: 'boolean',
    label: '信任反向代理',
    schema: publicApiEnvironmentSchema.shape.TRUST_PROXY,
    secret: false,
    section: 'public_api',
  },
  {
    defaultValue: '4',
    description: 'Telegram 采集工作进程的并发数（1-16）。',
    envName: 'TELEGRAM_WORKER_CONCURRENCY',
    kind: 'number',
    label: '采集并发数',
    schema: telegramEnvironmentSchema.shape.TELEGRAM_WORKER_CONCURRENCY,
    secret: false,
    section: 'ingestion',
  },
];

export const CONFIGURABLE_ENV_NAMES: ReadonlySet<string> = new Set(
  CONFIGURABLE_SETTINGS.map((setting) => setting.envName),
);

export function getConfigurableSetting(envName: string): ConfigurableSetting | undefined {
  return CONFIGURABLE_SETTINGS.find((setting) => setting.envName === envName);
}

/** Extracts the registry-keyed values present in an environment map. */
export function configurableEnvValues(environment: NodeJS.ProcessEnv): Record<string, string> {
  const values: Record<string, string> = {};
  for (const setting of CONFIGURABLE_SETTINGS) {
    const value = environment[setting.envName];
    if (typeof value === 'string') {
      values[setting.envName] = value;
    }
  }
  return values;
}

export interface ConfigCenterBootState {
  /** Registry-keyed values from shell + .env, before database overrides. */
  baseEnv: Record<string, string>;
  /** Overrides loaded from the database at boot. */
  bootOverrides: Record<string, string>;
  /** Registry-keyed values resolved at boot (base + overrides + explicit). */
  effectiveEnv: Record<string, string>;
  /** Registry-keyed names explicitly set in the shell before .env loading. */
  explicitEnvNames: ReadonlySet<string>;
}

export interface MaskedSecretValue {
  last4?: string;
  set: boolean;
}

export function maskSecretValue(value: string | null | undefined): MaskedSecretValue {
  if (typeof value !== 'string' || value.length === 0) {
    return { set: false };
  }
  return value.length > 4 ? { last4: value.slice(-4), set: true } : { set: true };
}
