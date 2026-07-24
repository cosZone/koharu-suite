CREATE TABLE "media_cache_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation" varchar(16) NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"object_id" uuid,
	"initiator_id" text NOT NULL,
	"reason" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"result" jsonb,
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "media_cache_commands_operation_check" CHECK ("media_cache_commands"."operation" in ('evict', 'reconcile')),
	CONSTRAINT "media_cache_commands_target_check" CHECK (("media_cache_commands"."operation" = 'evict' and "media_cache_commands"."object_id" is not null)
        or ("media_cache_commands"."operation" = 'reconcile' and "media_cache_commands"."object_id" is null)),
	CONSTRAINT "media_cache_commands_initiator_check" CHECK (length(btrim("media_cache_commands"."initiator_id")) between 1 and 255
        and length(btrim("media_cache_commands"."reason")) between 1 and 500),
	CONSTRAINT "media_cache_commands_attempt_check" CHECK ("media_cache_commands"."attempt_count" between 0 and 100),
	CONSTRAINT "media_cache_commands_lease_check" CHECK ((
          "media_cache_commands"."state" = 'running'
          and "media_cache_commands"."lease_owner" is not null
          and length(btrim("media_cache_commands"."lease_owner")) between 1 and 255
          and "media_cache_commands"."lease_token" is not null
          and "media_cache_commands"."lease_expires_at" is not null
          and "media_cache_commands"."completed_at" is null
        ) or (
          "media_cache_commands"."state" <> 'running'
          and "media_cache_commands"."lease_owner" is null
          and "media_cache_commands"."lease_token" is null
          and "media_cache_commands"."lease_expires_at" is null
        )),
	CONSTRAINT "media_cache_commands_terminal_check" CHECK ((
          "media_cache_commands"."state" = 'succeeded'
          and "media_cache_commands"."result" is not null
          and jsonb_typeof("media_cache_commands"."result") = 'object'
          and "media_cache_commands"."error_code" is null
          and "media_cache_commands"."completed_at" is not null
        ) or (
          "media_cache_commands"."state" = 'failed'
          and "media_cache_commands"."result" is null
          and "media_cache_commands"."error_code" is not null
          and "media_cache_commands"."completed_at" is not null
        ) or (
          "media_cache_commands"."state" in ('pending', 'running')
          and "media_cache_commands"."result" is null
          and "media_cache_commands"."error_code" is null
          and "media_cache_commands"."completed_at" is null
        ))
);
--> statement-breakpoint
ALTER TABLE "media_cache_commands" ADD CONSTRAINT "media_cache_commands_object_id_media_cache_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."media_cache_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_cache_commands_claim_idx" ON "media_cache_commands" USING btree ("state","lease_expires_at","created_at","id") WHERE "media_cache_commands"."state" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "media_cache_commands_object_idx" ON "media_cache_commands" USING btree ("object_id","created_at","id");