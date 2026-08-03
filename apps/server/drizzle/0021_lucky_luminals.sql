CREATE TABLE "archive_export_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"selection" jsonb NOT NULL,
	"include_provenance" boolean NOT NULL,
	"format_version" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"snapshot_at" timestamp with time zone,
	"artifact_sha256" char(64),
	"artifact_byte_length" bigint,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archive_export_runs_selection_check" CHECK (jsonb_typeof("archive_export_runs"."selection") = 'object'),
	CONSTRAINT "archive_export_runs_report_check" CHECK (jsonb_typeof("archive_export_runs"."report") = 'object'),
	CONSTRAINT "archive_export_runs_version_check" CHECK ("archive_export_runs"."format_version" > 0 and "archive_export_runs"."schema_version" > 0),
	CONSTRAINT "archive_export_runs_status_check" CHECK ("archive_export_runs"."status" in ('running', 'completed', 'failed', 'interrupted')),
	CONSTRAINT "archive_export_runs_lifecycle_check" CHECK ((
          "archive_export_runs"."status" = 'running'
          and "archive_export_runs"."completed_at" is null
          and "archive_export_runs"."artifact_sha256" is null
          and "archive_export_runs"."artifact_byte_length" is null
        ) or (
          "archive_export_runs"."status" = 'completed'
          and "archive_export_runs"."completed_at" is not null
          and "archive_export_runs"."snapshot_at" is not null
          and "archive_export_runs"."artifact_sha256" is not null
          and "archive_export_runs"."artifact_byte_length" > 0
        ) or (
          "archive_export_runs"."status" in ('failed', 'interrupted')
          and "archive_export_runs"."completed_at" is not null
          and "archive_export_runs"."artifact_sha256" is null
          and "archive_export_runs"."artifact_byte_length" is null
        )),
	CONSTRAINT "archive_export_runs_sha256_check" CHECK ("archive_export_runs"."artifact_sha256" is null or "archive_export_runs"."artifact_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "archive_export_runs_started_idx" ON "archive_export_runs" USING btree ("started_at");