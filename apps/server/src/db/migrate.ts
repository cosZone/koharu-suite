import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const MIGRATION_LOCK_NAMESPACE = 1_267_663_173;
const MIGRATION_LOCK_KEY = 1;
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

async function repairMissingBotSourceObservations(client: postgres.Sql): Promise<void> {
  const [table] = await client<{ exists: boolean }[]>`
    select to_regclass('public.message_source_observations') is not null as exists
  `;
  if (!table?.exists) {
    return;
  }

  await client`
    insert into message_source_observations (
      source_kind,
      source_key,
      channel_id,
      message_id,
      revision_id,
      telegram_update_id,
      telegram_message_id,
      content_fingerprint,
      content_fingerprint_version,
      resolution,
      observed_at,
      raw_json,
      created_at
    )
    select
      'telegram_bot_update',
      revision.telegram_update_id::text,
      message.channel_id,
      message.id,
      revision.id,
      revision.telegram_update_id,
      message.telegram_message_id,
      encode(
        sha256(
          convert_to(
            jsonb_build_object(
              'version', 0,
              'contentKind', revision.content_kind,
              'text', revision.text,
              'entities', revision.entities,
              'authorSignature', revision.author_signature,
              'editedAt', revision.edited_at,
              'mediaGroupId', revision.media_group_id
            )::text,
            'UTF8'
          )
        ),
        'hex'
      ),
      0,
      'created',
      telegram_update.received_at,
      telegram_update.raw_json,
      revision.created_at
    from message_revisions as revision
    inner join messages as message on message.id = revision.message_id
    inner join telegram_updates as telegram_update
      on telegram_update.telegram_update_id = revision.telegram_update_id
    where revision.telegram_update_id is not null
      and not exists (
        select 1
        from message_source_observations as existing
        where existing.source_kind = 'telegram_bot_update'
          and existing.source_key = revision.telegram_update_id::text
      )
  `;
}

export async function runMigrations(
  databaseUrl: string,
  options: { migrationsFolder?: string } = {},
): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });

  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_KEY})`;

    try {
      await migrate(drizzle(client), {
        migrationsFolder: options.migrationsFolder ?? migrationsFolder,
      });
      await repairMissingBotSourceObservations(client);
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await client.end();
  }
}
