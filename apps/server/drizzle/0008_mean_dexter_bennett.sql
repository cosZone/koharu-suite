CREATE TABLE "import_run_observations" (
	"run_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"source_kind" varchar(32) DEFAULT 'telegram_desktop_json' NOT NULL,
	"replayed" boolean NOT NULL,
	"resolution_at_run" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_run_observations_pk" PRIMARY KEY("run_id","observation_id"),
	CONSTRAINT "import_run_observations_source_kind_check" CHECK ("import_run_observations"."source_kind" = 'telegram_desktop_json'),
	CONSTRAINT "import_run_observations_resolution_check" CHECK ("import_run_observations"."resolution_at_run" in ('created', 'matched', 'stale', 'conflict'))
);
--> statement-breakpoint
ALTER TABLE "import_run_observations" ADD CONSTRAINT "import_run_observations_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run_observations" ADD CONSTRAINT "import_run_observations_observation_source_fk" FOREIGN KEY ("observation_id","source_kind") REFERENCES "public"."message_source_observations"("id","source_kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "import_run_observations" (
	"run_id",
	"observation_id",
	"source_kind",
	"replayed",
	"resolution_at_run",
	"created_at"
)
SELECT
	"import_run_id",
	"id",
	"source_kind",
	false,
	"resolution",
	"created_at"
FROM "message_source_observations"
WHERE
	"import_run_id" IS NOT NULL
	AND "source_kind" = 'telegram_desktop_json'
ON CONFLICT ("run_id", "observation_id") DO NOTHING;--> statement-breakpoint
CREATE INDEX "import_run_observations_observation_idx" ON "import_run_observations" USING btree ("observation_id","created_at");
