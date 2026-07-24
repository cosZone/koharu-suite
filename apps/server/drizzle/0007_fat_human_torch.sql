CREATE TABLE "message_source_media_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observation_id" uuid NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"position" integer NOT NULL,
	"media_kind" varchar(32) NOT NULL,
	"availability" varchar(32) NOT NULL,
	"telegram_file_id" text,
	"telegram_file_unique_id" text,
	"desktop_source_path" text,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_source_media_observations_observation_position_unique" UNIQUE("observation_id","position"),
	CONSTRAINT "message_source_media_observations_position_check" CHECK ("message_source_media_observations"."position" >= 0),
	CONSTRAINT "message_source_media_observations_kind_check" CHECK ("message_source_media_observations"."media_kind" in ('animation', 'audio', 'document', 'photo', 'video', 'voice')),
	CONSTRAINT "message_source_media_observations_availability_check" CHECK ("message_source_media_observations"."availability" in (
        'available',
        'exceeds_maximum_size',
        'not_included',
        'unavailable'
      )),
	CONSTRAINT "message_source_media_observations_metadata_check" CHECK (jsonb_typeof("message_source_media_observations"."source_metadata") = 'object'),
	CONSTRAINT "message_source_media_observations_source_check" CHECK ((
          "message_source_media_observations"."source_kind" = 'telegram_bot_update'
          and "message_source_media_observations"."availability" = 'available'
          and "message_source_media_observations"."telegram_file_id" is not null
          and "message_source_media_observations"."telegram_file_unique_id" is not null
          and "message_source_media_observations"."desktop_source_path" is null
        ) or (
          "message_source_media_observations"."source_kind" = 'telegram_desktop_json'
          and "message_source_media_observations"."telegram_file_id" is null
          and "message_source_media_observations"."telegram_file_unique_id" is null
          and (
            (
              "message_source_media_observations"."availability" = 'available'
              and "message_source_media_observations"."desktop_source_path" is not null
              and length("message_source_media_observations"."desktop_source_path") between 1 and 1024
              and "message_source_media_observations"."desktop_source_path" !~ '(^/|^\\|^[A-Za-z]:|(^|/)\.\.?(/|$))'
              and "message_source_media_observations"."desktop_source_path" !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
              and "message_source_media_observations"."desktop_source_path" !~ '\\'
            ) or (
              "message_source_media_observations"."availability" <> 'available'
              and "message_source_media_observations"."desktop_source_path" is null
            )
          )
        ))
);
--> statement-breakpoint
CREATE TABLE "reconciliation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"finding_id" uuid NOT NULL,
	"action_kind" varchar(64) NOT NULL,
	"initiator_kind" varchar(32) NOT NULL,
	"initiator_id" text,
	"reason" text NOT NULL,
	"before_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"after_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_actions_initiator_check" CHECK ("reconciliation_actions"."initiator_kind" in ('local_operator', 'owner_session', 'service_token', 'worker')),
	CONSTRAINT "reconciliation_actions_reason_check" CHECK (length(btrim("reconciliation_actions"."reason")) between 1 and 500),
	CONSTRAINT "reconciliation_actions_state_check" CHECK (jsonb_typeof("reconciliation_actions"."before_state") = 'object'
        and jsonb_typeof("reconciliation_actions"."after_state") = 'object')
);
--> statement-breakpoint
CREATE TABLE "reconciliation_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stable_key" text NOT NULL,
	"telegram_chat_id" bigint,
	"message_id" uuid,
	"observation_id" uuid,
	"kind" varchar(64) NOT NULL,
	"severity" varchar(16) NOT NULL,
	"state" varchar(16) DEFAULT 'open' NOT NULL,
	"sanitized_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_version" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "reconciliation_findings_stable_key_unique" UNIQUE("stable_key"),
	CONSTRAINT "reconciliation_findings_kind_check" CHECK ("reconciliation_findings"."kind" in (
        'durable_pending',
        'durable_blocked',
        'operator_skipped',
        'disabled_window',
        'retention_risk',
        'transport_id_discontinuity',
        'message_id_candidate',
        'desktop_absence_candidate',
        'observation_stale',
        'observation_conflict',
        'media_evidence_missing',
        'derived_html_drift',
        'current_pointer_invalid'
      )),
	CONSTRAINT "reconciliation_findings_channel_scope_check" CHECK ((
          "reconciliation_findings"."kind" in ('transport_id_discontinuity', 'retention_risk')
          and "reconciliation_findings"."telegram_chat_id" is null
        ) or (
          "reconciliation_findings"."kind" not in ('transport_id_discontinuity', 'retention_risk')
          and "reconciliation_findings"."telegram_chat_id" is not null
        )),
	CONSTRAINT "reconciliation_findings_severity_check" CHECK ("reconciliation_findings"."severity" in ('warning', 'error')),
	CONSTRAINT "reconciliation_findings_state_check" CHECK ("reconciliation_findings"."state" in ('open', 'resolved', 'ignored')),
	CONSTRAINT "reconciliation_findings_details_check" CHECK (jsonb_typeof("reconciliation_findings"."sanitized_details") = 'object'),
	CONSTRAINT "reconciliation_findings_evidence_version_check" CHECK ("reconciliation_findings"."evidence_version" > 0),
	CONSTRAINT "reconciliation_findings_seen_at_check" CHECK ("reconciliation_findings"."first_seen_at" <= "reconciliation_findings"."last_seen_at"),
	CONSTRAINT "reconciliation_findings_resolved_at_check" CHECK (("reconciliation_findings"."state" = 'open' and "reconciliation_findings"."resolved_at" is null)
        or ("reconciliation_findings"."state" <> 'open' and "reconciliation_findings"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" varchar(32) NOT NULL,
	"scope" jsonb NOT NULL,
	"status" varchar(16) NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"initiator_kind" varchar(32) NOT NULL,
	"initiator_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "reconciliation_runs_mode_check" CHECK ("reconciliation_runs"."mode" in ('persisted_scan', 'scheduled_scan', 'apply')),
	CONSTRAINT "reconciliation_runs_status_check" CHECK ("reconciliation_runs"."status" in ('running', 'completed', 'partial', 'failed', 'interrupted')),
	CONSTRAINT "reconciliation_runs_scope_check" CHECK (jsonb_typeof("reconciliation_runs"."scope") = 'array'),
	CONSTRAINT "reconciliation_runs_report_check" CHECK (jsonb_typeof("reconciliation_runs"."report") = 'object'),
	CONSTRAINT "reconciliation_runs_completed_at_check" CHECK (("reconciliation_runs"."status" = 'running' and "reconciliation_runs"."completed_at" is null)
        or ("reconciliation_runs"."status" <> 'running' and "reconciliation_runs"."completed_at" is not null)),
	CONSTRAINT "reconciliation_runs_initiator_check" CHECK ("reconciliation_runs"."initiator_kind" in ('local_operator', 'owner_session', 'service_token', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "reconciliation_schedule" (
	"singleton_key" varchar(32) PRIMARY KEY DEFAULT 'telegram' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_seconds" integer DEFAULT 3600 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_token" uuid,
	"claimed_run_id" uuid,
	"last_run_id" uuid,
	"last_status" varchar(16),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_schedule_singleton_check" CHECK ("reconciliation_schedule"."singleton_key" = 'telegram'),
	CONSTRAINT "reconciliation_schedule_interval_check" CHECK ("reconciliation_schedule"."interval_seconds" > 0),
	CONSTRAINT "reconciliation_schedule_lease_check" CHECK ((
          "reconciliation_schedule"."lease_owner" is null
          and "reconciliation_schedule"."lease_expires_at" is null
          and "reconciliation_schedule"."lease_token" is null
          and "reconciliation_schedule"."claimed_run_id" is null
        ) or (
          "reconciliation_schedule"."lease_owner" is not null
          and "reconciliation_schedule"."lease_expires_at" is not null
          and "reconciliation_schedule"."lease_token" is not null
          and "reconciliation_schedule"."claimed_run_id" is not null
        )),
	CONSTRAINT "reconciliation_schedule_last_status_check" CHECK ("reconciliation_schedule"."last_status" is null
        or "reconciliation_schedule"."last_status" in ('completed', 'partial', 'failed', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "telegram_poll_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" bigint NOT NULL,
	"requested_offset" bigint,
	"checkpoint_offset" bigint NOT NULL,
	"returned_first_update_id" bigint NOT NULL,
	"returned_last_update_id" bigint NOT NULL,
	"returned_count" integer NOT NULL,
	"accepted_count" integer NOT NULL,
	"ignored_count" integer NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_poll_receipts_bot_checkpoint_unique" UNIQUE("bot_id","checkpoint_offset"),
	CONSTRAINT "telegram_poll_receipts_range_check" CHECK ("telegram_poll_receipts"."returned_first_update_id" <= "telegram_poll_receipts"."returned_last_update_id"
        and "telegram_poll_receipts"."checkpoint_offset" = "telegram_poll_receipts"."returned_last_update_id" + 1),
	CONSTRAINT "telegram_poll_receipts_counts_check" CHECK ("telegram_poll_receipts"."returned_count" > 0
        and "telegram_poll_receipts"."accepted_count" >= 0
        and "telegram_poll_receipts"."ignored_count" >= 0
        and "telegram_poll_receipts"."accepted_count" + "telegram_poll_receipts"."ignored_count" = "telegram_poll_receipts"."returned_count")
);
--> statement-breakpoint
ALTER TABLE "message_source_observations" ADD CONSTRAINT "message_source_observations_id_source_kind_unique" UNIQUE("id","source_kind");--> statement-breakpoint
ALTER TABLE "message_source_media_observations" ADD CONSTRAINT "message_source_media_observations_observation_source_fk" FOREIGN KEY ("observation_id","source_kind") REFERENCES "public"."message_source_observations"("id","source_kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_actions" ADD CONSTRAINT "reconciliation_actions_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_actions" ADD CONSTRAINT "reconciliation_actions_finding_id_reconciliation_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."reconciliation_findings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_telegram_chat_id_telegram_channel_allowlist_telegram_chat_id_fk" FOREIGN KEY ("telegram_chat_id") REFERENCES "public"."telegram_channel_allowlist"("telegram_chat_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_observation_id_message_source_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."message_source_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_schedule" ADD CONSTRAINT "reconciliation_schedule_claimed_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("claimed_run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_schedule" ADD CONSTRAINT "reconciliation_schedule_last_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_poll_receipts" ADD CONSTRAINT "telegram_poll_receipts_bot_id_telegram_polling_state_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."telegram_polling_state"("bot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "message_source_media_observations" (
	"observation_id",
	"source_kind",
	"position",
	"media_kind",
	"availability",
	"telegram_file_id",
	"telegram_file_unique_id",
	"desktop_source_path",
	"source_metadata",
	"created_at"
)
SELECT
	observation."id",
	observation."source_kind",
	media."position",
	media."kind",
	coalesce(media."availability_reason", 'available'),
	media."telegram_file_id",
	media."telegram_file_unique_id",
	media."source_path",
	media."source_metadata",
	media."created_at"
FROM "message_source_observations" AS observation
INNER JOIN "message_revisions" AS revision
	ON revision."id" = observation."revision_id"
INNER JOIN "message_media" AS media
	ON media."revision_id" = observation."revision_id"
	AND media."source_kind" = observation."source_kind"
WHERE
	(
		observation."source_kind" = 'telegram_bot_update'
		AND observation."telegram_update_id" = revision."telegram_update_id"
		AND media."availability_reason" IS NULL
		AND media."telegram_file_id" IS NOT NULL
		AND media."telegram_file_unique_id" IS NOT NULL
		AND media."source_path" IS NULL
	)
	OR
	(
		observation."source_kind" = 'telegram_desktop_json'
		AND NOT EXISTS (
			SELECT 1
			FROM "message_source_observations" AS sibling_observation
			WHERE
				sibling_observation."revision_id" = observation."revision_id"
				AND sibling_observation."source_kind" = observation."source_kind"
				AND sibling_observation."id" <> observation."id"
		)
		AND media."telegram_file_id" IS NULL
		AND media."telegram_file_unique_id" IS NULL
		AND (
			(
				media."availability_reason" IS NULL
				AND media."source_path" IS NOT NULL
				AND length(media."source_path") BETWEEN 1 AND 1024
				AND media."source_path" !~ '(^/|^\\|^[A-Za-z]:|(^|/)\.\.?(/|$))'
				AND media."source_path" !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
				AND media."source_path" !~ '\\'
			)
			OR
			(
				media."availability_reason" IN (
					'exceeds_maximum_size',
					'not_included',
					'unavailable'
				)
				AND media."source_path" IS NULL
			)
		)
	)
ON CONFLICT ("observation_id", "position") DO NOTHING;--> statement-breakpoint
CREATE INDEX "message_source_media_observations_observation_idx" ON "message_source_media_observations" USING btree ("observation_id");--> statement-breakpoint
CREATE INDEX "reconciliation_actions_finding_created_idx" ON "reconciliation_actions" USING btree ("finding_id","created_at");--> statement-breakpoint
CREATE INDEX "reconciliation_actions_run_idx" ON "reconciliation_actions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "reconciliation_findings_telegram_chat_state_kind_idx" ON "reconciliation_findings" USING btree ("telegram_chat_id","state","kind");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_started_idx" ON "reconciliation_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "telegram_poll_receipts_bot_completed_idx" ON "telegram_poll_receipts" USING btree ("bot_id","completed_at");
