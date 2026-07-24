CREATE TABLE "import_run_coverages" (
	"run_id" uuid NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"start_message_id" bigint NOT NULL,
	"end_message_id" bigint NOT NULL,
	"explicitly_complete" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_run_coverages_pk" PRIMARY KEY("run_id","telegram_chat_id","start_message_id","end_message_id"),
	CONSTRAINT "import_run_coverages_range_check" CHECK ("import_run_coverages"."start_message_id" > 0 and "import_run_coverages"."end_message_id" >= "import_run_coverages"."start_message_id"),
	CONSTRAINT "import_run_coverages_explicit_check" CHECK ("import_run_coverages"."explicitly_complete" is true)
);
--> statement-breakpoint
ALTER TABLE "reconciliation_findings" DROP CONSTRAINT "reconciliation_findings_kind_check";--> statement-breakpoint
ALTER TABLE "import_run_coverages" ADD CONSTRAINT "import_run_coverages_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run_coverages" ADD CONSTRAINT "import_run_coverages_telegram_chat_id_telegram_channel_allowlist_telegram_chat_id_fk" FOREIGN KEY ("telegram_chat_id") REFERENCES "public"."telegram_channel_allowlist"("telegram_chat_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_run_coverages_channel_range_idx" ON "import_run_coverages" USING btree ("telegram_chat_id","start_message_id","end_message_id","run_id");--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_kind_check" CHECK ("reconciliation_findings"."kind" in (
        'durable_pending',
        'durable_blocked',
        'import_lineage_missing',
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
      ));