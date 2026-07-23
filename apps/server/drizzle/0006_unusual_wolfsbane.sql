CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"source_file_sha256" text NOT NULL,
	"parser_version" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"selected_channels" jsonb NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_runs_source_kind_check" CHECK ("import_runs"."source_kind" = 'telegram_desktop_json'),
	CONSTRAINT "import_runs_parser_version_check" CHECK ("import_runs"."parser_version" > 0),
	CONSTRAINT "import_runs_status_check" CHECK ("import_runs"."status" in ('running', 'completed', 'partial', 'interrupted')),
	CONSTRAINT "import_runs_completed_at_check" CHECK (("import_runs"."status" = 'running' and "import_runs"."completed_at" is null)
        or ("import_runs"."status" <> 'running' and "import_runs"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "message_source_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"source_key" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"revision_id" uuid,
	"import_run_id" uuid,
	"telegram_update_id" bigint,
	"telegram_message_id" bigint NOT NULL,
	"content_fingerprint" text NOT NULL,
	"content_fingerprint_version" integer NOT NULL,
	"resolution" varchar(16) NOT NULL,
	"observed_at" timestamp with time zone,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_source_observations_source_check" CHECK (("message_source_observations"."source_kind" = 'telegram_bot_update'
          and "message_source_observations"."telegram_update_id" is not null
          and "message_source_observations"."import_run_id" is null)
        or ("message_source_observations"."source_kind" = 'telegram_desktop_json'
          and "message_source_observations"."telegram_update_id" is null)),
	CONSTRAINT "message_source_observations_resolution_check" CHECK ("message_source_observations"."resolution" in ('created', 'matched', 'stale', 'conflict')),
	CONSTRAINT "message_source_observations_fingerprint_version_check" CHECK ("message_source_observations"."content_fingerprint_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "message_media" ALTER COLUMN "telegram_file_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_media" ALTER COLUMN "telegram_file_unique_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_revisions" ALTER COLUMN "telegram_update_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_media" ADD COLUMN "source_kind" varchar(32) DEFAULT 'telegram_bot_update' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_media" ADD COLUMN "source_path" text;--> statement-breakpoint
ALTER TABLE "message_media" ADD COLUMN "source_media_type" text;--> statement-breakpoint
ALTER TABLE "message_media" ADD COLUMN "availability_reason" text;--> statement-breakpoint
ALTER TABLE "message_media" ADD COLUMN "source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "message_source_observations" ADD CONSTRAINT "message_source_observations_channel_id_telegram_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."telegram_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_source_observations" ADD CONSTRAINT "message_source_observations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_source_observations" ADD CONSTRAINT "message_source_observations_revision_id_message_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."message_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_source_observations" ADD CONSTRAINT "message_source_observations_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_source_observations" ADD CONSTRAINT "message_source_observations_telegram_update_id_telegram_updates_telegram_update_id_fk" FOREIGN KEY ("telegram_update_id") REFERENCES "public"."telegram_updates"("telegram_update_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
UPDATE "message_media"
SET "source_media_type" = "kind"
WHERE "source_kind" = 'telegram_bot_update'
	AND "source_media_type" IS NULL;--> statement-breakpoint
INSERT INTO "message_source_observations" (
	"source_kind",
	"source_key",
	"channel_id",
	"message_id",
	"revision_id",
	"telegram_update_id",
	"telegram_message_id",
	"content_fingerprint",
	"content_fingerprint_version",
	"resolution",
	"observed_at",
	"raw_json",
	"created_at"
)
SELECT
	'telegram_bot_update',
	revision."telegram_update_id"::text,
	message."channel_id",
	message."id",
	revision."id",
	revision."telegram_update_id",
	message."telegram_message_id",
	encode(
		sha256(
			convert_to(
				jsonb_build_object(
					'version', 0,
					'contentKind', revision."content_kind",
					'text', revision."text",
					'entities', revision."entities",
					'authorSignature', revision."author_signature",
					'editedAt', revision."edited_at",
					'mediaGroupId', revision."media_group_id"
				)::text,
				'UTF8'
			)
		),
		'hex'
	),
	0,
	'created',
	telegram_update."received_at",
	telegram_update."raw_json",
	revision."created_at"
FROM "message_revisions" AS revision
INNER JOIN "messages" AS message ON message."id" = revision."message_id"
INNER JOIN "telegram_updates" AS telegram_update
	ON telegram_update."telegram_update_id" = revision."telegram_update_id"
WHERE revision."telegram_update_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "import_runs_source_file_idx" ON "import_runs" USING btree ("source_file_sha256","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_source_observations_source_key_unique" ON "message_source_observations" USING btree ("source_kind","source_key");--> statement-breakpoint
CREATE INDEX "message_source_observations_message_idx" ON "message_source_observations" USING btree ("message_id","created_at");--> statement-breakpoint
CREATE INDEX "message_source_observations_revision_idx" ON "message_source_observations" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "message_source_observations_import_run_idx" ON "message_source_observations" USING btree ("import_run_id");--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_source_check" CHECK (("message_media"."source_kind" = 'telegram_bot_update'
          and "message_media"."telegram_file_id" is not null
          and "message_media"."telegram_file_unique_id" is not null
          and "message_media"."source_path" is null)
        or ("message_media"."source_kind" = 'telegram_desktop_json'
          and "message_media"."telegram_file_id" is null
          and "message_media"."telegram_file_unique_id" is null));
