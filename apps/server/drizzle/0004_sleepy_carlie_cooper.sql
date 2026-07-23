CREATE TABLE "auth_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"reference_id" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0 NOT NULL,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "operation_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" varchar(32) NOT NULL,
	"actor_id" text NOT NULL,
	"action" varchar(64) NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" text NOT NULL,
	"reason" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "telegram_ingest_tasks_channel_head_idx";--> statement-breakpoint
DROP INDEX "telegram_ingest_tasks_runnable_idx";--> statement-breakpoint
ALTER TABLE "message_revisions" ADD COLUMN "html" text;--> statement-breakpoint
ALTER TABLE "message_revisions" ADD COLUMN "renderer_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_channel_allowlist" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_channel_allowlist" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_ingest_tasks" ADD COLUMN "skipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_ingest_tasks" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "auth_api_keys" ADD CONSTRAINT "auth_api_keys_reference_id_auth_users_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_api_keys_key_unique" ON "auth_api_keys" USING btree ("key");--> statement-breakpoint
CREATE INDEX "auth_api_keys_config_id_idx" ON "auth_api_keys" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "auth_api_keys_reference_id_idx" ON "auth_api_keys" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "operation_audit_events_actor_idx" ON "operation_audit_events" USING btree ("actor_type","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "operation_audit_events_target_idx" ON "operation_audit_events" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "telegram_ingest_tasks_channel_head_idx" ON "telegram_ingest_tasks" USING btree ("telegram_chat_id","telegram_update_id") WHERE "telegram_ingest_tasks"."processed_at" is null and "telegram_ingest_tasks"."skipped_at" is null;--> statement-breakpoint
CREATE INDEX "telegram_ingest_tasks_runnable_idx" ON "telegram_ingest_tasks" USING btree ("available_at","telegram_update_id") WHERE "telegram_ingest_tasks"."processed_at" is null and "telegram_ingest_tasks"."skipped_at" is null and "telegram_ingest_tasks"."blocked_at" is null;--> statement-breakpoint
ALTER TABLE "telegram_channel_allowlist" ADD CONSTRAINT "telegram_channel_allowlist_enabled_check" CHECK (("telegram_channel_allowlist"."enabled" and "telegram_channel_allowlist"."disabled_at" is null)
        or (not "telegram_channel_allowlist"."enabled" and "telegram_channel_allowlist"."disabled_at" is not null));--> statement-breakpoint
ALTER TABLE "telegram_ingest_tasks" ADD CONSTRAINT "telegram_ingest_tasks_terminal_check" CHECK (not ("telegram_ingest_tasks"."processed_at" is not null and "telegram_ingest_tasks"."skipped_at" is not null));--> statement-breakpoint
ALTER TABLE "telegram_ingest_tasks" ADD CONSTRAINT "telegram_ingest_tasks_skip_reason_check" CHECK (("telegram_ingest_tasks"."skipped_at" is null and "telegram_ingest_tasks"."skip_reason" is null)
        or ("telegram_ingest_tasks"."skipped_at" is not null and length("telegram_ingest_tasks"."skip_reason") between 1 and 500));