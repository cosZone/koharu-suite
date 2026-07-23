CREATE TABLE "worker_runtime" (
	"singleton_key" text PRIMARY KEY DEFAULT 'telegram' NOT NULL,
	"instance_id" text NOT NULL,
	"state" varchar(16) NOT NULL,
	"version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"last_telegram_success_at" timestamp with time zone,
	CONSTRAINT "worker_runtime_singleton_key_check" CHECK ("worker_runtime"."singleton_key" = 'telegram'),
	CONSTRAINT "worker_runtime_state_check" CHECK ("worker_runtime"."state" in ('starting', 'running', 'stopping'))
);
