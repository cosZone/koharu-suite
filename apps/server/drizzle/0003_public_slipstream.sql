CREATE TABLE "telegram_channel_allowlist" (
	"telegram_chat_id" bigint PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"username" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "telegram_channel_allowlist" (
	"telegram_chat_id",
	"title",
	"username",
	"created_at",
	"updated_at"
)
SELECT
	"telegram_chat_id",
	"title",
	"username",
	"created_at",
	"updated_at"
FROM "telegram_channels"
ON CONFLICT ("telegram_chat_id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE "telegram_ingest_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" bigint NOT NULL,
	"telegram_update_id" bigint NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"update_type" varchar(32) NOT NULL,
	"raw_json" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"blocked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_polling_state" (
	"singleton" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"bot_id" bigint NOT NULL,
	"next_update_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_polling_state_singleton_check" CHECK ("telegram_polling_state"."singleton" = 1)
);
--> statement-breakpoint
ALTER TABLE "message_revisions" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_ingest_tasks" ADD CONSTRAINT "telegram_ingest_tasks_telegram_chat_id_telegram_channel_allowlist_telegram_chat_id_fk" FOREIGN KEY ("telegram_chat_id") REFERENCES "public"."telegram_channel_allowlist"("telegram_chat_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_ingest_tasks_update_id_unique" ON "telegram_ingest_tasks" USING btree ("telegram_update_id");--> statement-breakpoint
CREATE INDEX "telegram_ingest_tasks_channel_head_idx" ON "telegram_ingest_tasks" USING btree ("telegram_chat_id","telegram_update_id") WHERE "telegram_ingest_tasks"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "telegram_ingest_tasks_runnable_idx" ON "telegram_ingest_tasks" USING btree ("available_at","telegram_update_id") WHERE "telegram_ingest_tasks"."processed_at" is null and "telegram_ingest_tasks"."blocked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_polling_state_bot_id_unique" ON "telegram_polling_state" USING btree ("bot_id");
