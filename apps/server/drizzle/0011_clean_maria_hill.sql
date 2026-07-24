CREATE TABLE "media_cache_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" uuid,
	"blob_sha256" char(64),
	"action_kind" varchar(32) NOT NULL,
	"initiator_kind" varchar(32) NOT NULL,
	"initiator_id" text,
	"reason" text,
	"before_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"after_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_cache_actions_kind_check" CHECK ("media_cache_actions"."action_kind" in (
        'retry',
        'evict',
        'reconcile',
        'recover_orphan',
        'restore_missing'
      )),
	CONSTRAINT "media_cache_actions_initiator_check" CHECK ("media_cache_actions"."initiator_kind" in ('local_operator', 'owner_session', 'worker')),
	CONSTRAINT "media_cache_actions_reason_check" CHECK ((
          "media_cache_actions"."initiator_kind" = 'worker'
          and (
            "media_cache_actions"."reason" is null
            or length(btrim("media_cache_actions"."reason")) between 1 and 500
          )
        ) or (
          "media_cache_actions"."initiator_kind" in ('local_operator', 'owner_session')
          and length(btrim("media_cache_actions"."reason")) between 1 and 500
        )),
	CONSTRAINT "media_cache_actions_state_check" CHECK (jsonb_typeof("media_cache_actions"."before_state") = 'object'
        and jsonb_typeof("media_cache_actions"."after_state") = 'object')
);
--> statement-breakpoint
CREATE TABLE "media_cache_blobs" (
	"sha256" char(64) PRIMARY KEY NOT NULL,
	"byte_length" bigint NOT NULL,
	"detected_mime" varchar(127) NOT NULL,
	"relative_key" text NOT NULL,
	"state" varchar(16) NOT NULL,
	"eviction_owner" text,
	"eviction_token" uuid,
	"eviction_expires_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_cache_blobs_sha256_check" CHECK ("media_cache_blobs"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_cache_blobs_byte_length_check" CHECK ("media_cache_blobs"."byte_length" > 0),
	CONSTRAINT "media_cache_blobs_mime_check" CHECK ("media_cache_blobs"."detected_mime" in (
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/avif',
        'image/gif',
        'video/mp4',
        'video/webm'
      )),
	CONSTRAINT "media_cache_blobs_relative_key_check" CHECK ("media_cache_blobs"."relative_key"
        = 'blobs/' || substr("media_cache_blobs"."sha256", 1, 2)
          || '/' || substr("media_cache_blobs"."sha256", 3, 2)
          || '/' || "media_cache_blobs"."sha256"),
	CONSTRAINT "media_cache_blobs_state_check" CHECK ("media_cache_blobs"."state" in ('ready', 'deleting', 'evicted', 'missing')),
	CONSTRAINT "media_cache_blobs_eviction_lease_check" CHECK ((
          "media_cache_blobs"."state" = 'deleting'
          and "media_cache_blobs"."eviction_owner" is not null
          and length(btrim("media_cache_blobs"."eviction_owner")) between 1 and 255
          and "media_cache_blobs"."eviction_token" is not null
          and "media_cache_blobs"."eviction_expires_at" is not null
        ) or (
          "media_cache_blobs"."state" <> 'deleting'
          and "media_cache_blobs"."eviction_owner" is null
          and "media_cache_blobs"."eviction_token" is null
          and "media_cache_blobs"."eviction_expires_at" is null
        ))
);
--> statement-breakpoint
CREATE TABLE "media_cache_object_sources" (
	"object_id" uuid NOT NULL,
	"source_media_observation_id" uuid NOT NULL,
	"source_priority" integer NOT NULL,
	CONSTRAINT "media_cache_object_sources_pk" PRIMARY KEY("object_id","source_media_observation_id"),
	CONSTRAINT "media_cache_object_sources_priority_check" CHECK ("media_cache_object_sources"."source_priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE "media_cache_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_plan_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"canonical_media_id" uuid NOT NULL,
	"variant" varchar(16) NOT NULL,
	"recipe_version" integer NOT NULL,
	"state" varchar(32) DEFAULT 'discovered' NOT NULL,
	"blob_sha256" char(64),
	"declared_bytes" bigint,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"actual_bytes" bigint,
	"reason_code" varchar(64),
	"last_error_class" varchar(64),
	"last_error_code" varchar(64),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_cache_objects_media_variant_recipe_unique" UNIQUE("canonical_media_id","variant","recipe_version"),
	CONSTRAINT "media_cache_objects_variant_check" CHECK ("media_cache_objects"."variant" in ('original', 'thumbnail')),
	CONSTRAINT "media_cache_objects_recipe_check" CHECK ("media_cache_objects"."recipe_version" > 0
        and ("media_cache_objects"."variant" <> 'original' or "media_cache_objects"."recipe_version" = 1)),
	CONSTRAINT "media_cache_objects_state_check" CHECK ("media_cache_objects"."state" in (
        'discovered',
        'awaiting_local_source',
        'reserved',
        'downloading',
        'staging',
        'ready',
        'skipped',
        'retry_wait',
        'blocked',
        'deleting',
        'evicted',
        'missing',
        'integrity_conflict'
      )),
	CONSTRAINT "media_cache_objects_bytes_check" CHECK (("media_cache_objects"."declared_bytes" is null or "media_cache_objects"."declared_bytes" >= 0)
        and "media_cache_objects"."reserved_bytes" >= 0
        and ("media_cache_objects"."actual_bytes" is null or "media_cache_objects"."actual_bytes" > 0)
        and (
          ("media_cache_objects"."variant" = 'original'
            and "media_cache_objects"."reserved_bytes" <= 20971520)
          or ("media_cache_objects"."variant" = 'thumbnail'
            and "media_cache_objects"."reserved_bytes" <= 1048576)
        )),
	CONSTRAINT "media_cache_objects_ready_check" CHECK ("media_cache_objects"."state" <> 'ready'
        or (
          "media_cache_objects"."blob_sha256" is not null
          and "media_cache_objects"."actual_bytes" is not null
          and "media_cache_objects"."reserved_bytes" = 0
        )),
	CONSTRAINT "media_cache_objects_attempt_check" CHECK ("media_cache_objects"."attempt_count" between 0 and 10),
	CONSTRAINT "media_cache_objects_lease_check" CHECK ((
          "media_cache_objects"."state" in ('reserved', 'downloading', 'staging')
          and "media_cache_objects"."lease_owner" is not null
          and length(btrim("media_cache_objects"."lease_owner")) between 1 and 255
          and "media_cache_objects"."lease_token" is not null
          and "media_cache_objects"."lease_expires_at" is not null
        ) or (
          "media_cache_objects"."state" not in ('reserved', 'downloading', 'staging')
          and "media_cache_objects"."lease_owner" is null
          and "media_cache_objects"."lease_token" is null
          and "media_cache_objects"."lease_expires_at" is null
        ))
);
--> statement-breakpoint
CREATE TABLE "media_cache_post_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"state" varchar(32) DEFAULT 'discovered' NOT NULL,
	"ready_original_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_original_bytes" bigint DEFAULT 0 NOT NULL,
	"reason_code" varchar(64),
	"last_error_class" varchar(64),
	"last_error_code" varchar(64),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_cache_post_plans_id_revision_unique" UNIQUE("id","revision_id"),
	CONSTRAINT "media_cache_post_plans_revision_unique" UNIQUE("revision_id"),
	CONSTRAINT "media_cache_post_plans_state_check" CHECK ("media_cache_post_plans"."state" in (
        'discovered',
        'awaiting_local_source',
        'reserved',
        'staging',
        'settling',
        'recovering',
        'ready',
        'skipped',
        'retry_wait',
        'blocked'
      )),
	CONSTRAINT "media_cache_post_plans_budget_check" CHECK ("media_cache_post_plans"."ready_original_bytes" >= 0
        and "media_cache_post_plans"."reserved_original_bytes" >= 0
        and "media_cache_post_plans"."ready_original_bytes" + "media_cache_post_plans"."reserved_original_bytes"
          <= 52428800),
	CONSTRAINT "media_cache_post_plans_attempt_check" CHECK ("media_cache_post_plans"."attempt_count" between 0 and 10),
	CONSTRAINT "media_cache_post_plans_lease_check" CHECK ((
          "media_cache_post_plans"."state" in ('reserved', 'staging', 'settling', 'recovering')
          and "media_cache_post_plans"."lease_owner" is not null
          and length(btrim("media_cache_post_plans"."lease_owner")) between 1 and 255
          and "media_cache_post_plans"."lease_token" is not null
          and "media_cache_post_plans"."lease_expires_at" is not null
        ) or (
          "media_cache_post_plans"."state" not in ('reserved', 'staging', 'settling', 'recovering')
          and "media_cache_post_plans"."lease_owner" is null
          and "media_cache_post_plans"."lease_token" is null
          and "media_cache_post_plans"."lease_expires_at" is null
        ))
);
--> statement-breakpoint
CREATE TABLE "media_cache_runtime" (
	"singleton_key" varchar(16) PRIMARY KEY DEFAULT 'local' NOT NULL,
	"discovery_cursor_created_at" timestamp with time zone,
	"discovery_cursor_id" uuid,
	"ready_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"max_bytes" bigint DEFAULT 5368709120 NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_cache_runtime_singleton_check" CHECK ("media_cache_runtime"."singleton_key" = 'local'),
	CONSTRAINT "media_cache_runtime_cursor_check" CHECK (("media_cache_runtime"."discovery_cursor_created_at" is null and "media_cache_runtime"."discovery_cursor_id" is null)
        or ("media_cache_runtime"."discovery_cursor_created_at" is not null and "media_cache_runtime"."discovery_cursor_id" is not null)),
	CONSTRAINT "media_cache_runtime_ledger_check" CHECK ("media_cache_runtime"."ready_bytes" >= 0
        and "media_cache_runtime"."ready_bytes" <= 5368709120
        and "media_cache_runtime"."reserved_bytes" >= 0
        and "media_cache_runtime"."reserved_bytes" <= 5368709120
        and "media_cache_runtime"."max_bytes" > 0
        and "media_cache_runtime"."max_bytes" <= 5368709120)
);
--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_id_revision_unique" UNIQUE("id","revision_id");--> statement-breakpoint
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_id_message_unique" UNIQUE("id","message_id");--> statement-breakpoint
CREATE FUNCTION "media_cache_reject_blob_rebind"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.blob_sha256 IS NOT NULL
		AND NEW.blob_sha256 IS DISTINCT FROM OLD.blob_sha256 THEN
		RAISE EXCEPTION 'media cache object blob hash is immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "media_cache_objects_blob_immutable"
BEFORE UPDATE OF "blob_sha256" ON "media_cache_objects"
FOR EACH ROW
EXECUTE FUNCTION "media_cache_reject_blob_rebind"();--> statement-breakpoint
CREATE FUNCTION "media_cache_reject_object_identity_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.post_plan_id IS DISTINCT FROM OLD.post_plan_id
		OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
		OR NEW.canonical_media_id IS DISTINCT FROM OLD.canonical_media_id
		OR NEW.variant IS DISTINCT FROM OLD.variant
		OR NEW.recipe_version IS DISTINCT FROM OLD.recipe_version THEN
		RAISE EXCEPTION 'media cache object identity is immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "media_cache_objects_identity_immutable"
BEFORE UPDATE OF "post_plan_id", "revision_id", "canonical_media_id", "variant", "recipe_version"
ON "media_cache_objects"
FOR EACH ROW
EXECUTE FUNCTION "media_cache_reject_object_identity_change"();--> statement-breakpoint
CREATE FUNCTION "media_cache_reject_blob_identity_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.sha256 IS DISTINCT FROM OLD.sha256
		OR NEW.byte_length IS DISTINCT FROM OLD.byte_length
		OR NEW.detected_mime IS DISTINCT FROM OLD.detected_mime
		OR NEW.relative_key IS DISTINCT FROM OLD.relative_key THEN
		RAISE EXCEPTION 'media cache blob identity metadata is immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "media_cache_blobs_identity_immutable"
BEFORE UPDATE OF "sha256", "byte_length", "detected_mime", "relative_key" ON "media_cache_blobs"
FOR EACH ROW
EXECUTE FUNCTION "media_cache_reject_blob_identity_change"();--> statement-breakpoint
CREATE FUNCTION "media_cache_validate_object_source"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM media_cache_objects AS object
		JOIN message_media AS canonical_media
			ON canonical_media.id = object.canonical_media_id
			AND canonical_media.revision_id = object.revision_id
		JOIN message_revisions AS revision
			ON revision.id = object.revision_id
		JOIN messages AS message
			ON message.id = revision.message_id
		JOIN message_source_media_observations AS source_media
			ON source_media.id = NEW.source_media_observation_id
		JOIN message_source_observations AS source_observation
			ON source_observation.id = source_media.observation_id
			AND source_observation.source_kind = source_media.source_kind
		WHERE object.id = NEW.object_id
			AND source_media.availability = 'available'
			AND source_observation.resolution IN ('created', 'matched')
			AND source_observation.revision_id IS NOT NULL
			AND source_observation.revision_id = object.revision_id
			AND source_observation.message_id = revision.message_id
			AND source_media.position = canonical_media.position
			AND source_media.media_kind = canonical_media.kind
			AND message.current_revision_number = revision.revision_number
			AND message.tombstoned_at IS NULL
	) THEN
		RAISE EXCEPTION 'media cache object source is not current matching available evidence'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "media_cache_object_sources_validate"
BEFORE INSERT OR UPDATE ON "media_cache_object_sources"
FOR EACH ROW
EXECUTE FUNCTION "media_cache_validate_object_source"();--> statement-breakpoint
ALTER TABLE "media_cache_actions" ADD CONSTRAINT "media_cache_actions_object_id_media_cache_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."media_cache_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_cache_actions" ADD CONSTRAINT "media_cache_actions_blob_sha256_media_cache_blobs_sha256_fk" FOREIGN KEY ("blob_sha256") REFERENCES "public"."media_cache_blobs"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_cache_object_sources" ADD CONSTRAINT "media_cache_object_sources_object_id_media_cache_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."media_cache_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_cache_object_sources" ADD CONSTRAINT "media_cache_object_sources_source_media_observation_id_message_source_media_observations_id_fk" FOREIGN KEY ("source_media_observation_id") REFERENCES "public"."message_source_media_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_cache_objects" ADD CONSTRAINT "media_cache_objects_blob_sha256_media_cache_blobs_sha256_fk" FOREIGN KEY ("blob_sha256") REFERENCES "public"."media_cache_blobs"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_cache_objects" ADD CONSTRAINT "media_cache_objects_plan_revision_fk" FOREIGN KEY ("post_plan_id","revision_id") REFERENCES "public"."media_cache_post_plans"("id","revision_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_cache_objects" ADD CONSTRAINT "media_cache_objects_media_revision_fk" FOREIGN KEY ("canonical_media_id","revision_id") REFERENCES "public"."message_media"("id","revision_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_cache_post_plans" ADD CONSTRAINT "media_cache_post_plans_revision_message_fk" FOREIGN KEY ("revision_id","message_id") REFERENCES "public"."message_revisions"("id","message_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_cache_actions_created_idx" ON "media_cache_actions" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "media_cache_actions_object_created_idx" ON "media_cache_actions" USING btree ("object_id","created_at","id");--> statement-breakpoint
CREATE INDEX "media_cache_actions_blob_created_idx" ON "media_cache_actions" USING btree ("blob_sha256","created_at","id");--> statement-breakpoint
CREATE INDEX "media_cache_blobs_lru_idx" ON "media_cache_blobs" USING btree ("last_accessed_at","sha256") WHERE "media_cache_blobs"."state" = 'ready';--> statement-breakpoint
CREATE INDEX "media_cache_blobs_state_idx" ON "media_cache_blobs" USING btree ("state","sha256");--> statement-breakpoint
CREATE INDEX "media_cache_blobs_eviction_expiry_idx" ON "media_cache_blobs" USING btree ("eviction_expires_at","sha256") WHERE "media_cache_blobs"."state" = 'deleting';--> statement-breakpoint
CREATE INDEX "media_cache_object_sources_resolver_idx" ON "media_cache_object_sources" USING btree ("object_id","source_priority","source_media_observation_id");--> statement-breakpoint
CREATE INDEX "media_cache_object_sources_observation_idx" ON "media_cache_object_sources" USING btree ("source_media_observation_id","object_id");--> statement-breakpoint
CREATE INDEX "media_cache_objects_plan_state_idx" ON "media_cache_objects" USING btree ("post_plan_id","state","id");--> statement-breakpoint
CREATE INDEX "media_cache_objects_blob_state_idx" ON "media_cache_objects" USING btree ("blob_sha256","state","id");--> statement-breakpoint
CREATE INDEX "media_cache_objects_state_updated_idx" ON "media_cache_objects" USING btree ("state","updated_at","id");--> statement-breakpoint
CREATE INDEX "media_cache_objects_blob_plan_idx" ON "media_cache_objects" USING btree ("blob_sha256","post_plan_id") WHERE "media_cache_objects"."blob_sha256" is not null;--> statement-breakpoint
CREATE INDEX "media_cache_objects_runnable_idx" ON "media_cache_objects" USING btree ("available_at","id") WHERE "media_cache_objects"."state" in ('discovered', 'retry_wait');--> statement-breakpoint
CREATE INDEX "media_cache_objects_lease_expiry_idx" ON "media_cache_objects" USING btree ("lease_expires_at","id") WHERE "media_cache_objects"."lease_token" is not null;--> statement-breakpoint
CREATE INDEX "media_cache_post_plans_runnable_idx" ON "media_cache_post_plans" USING btree ("available_at","id") WHERE "media_cache_post_plans"."state" in ('discovered', 'retry_wait');--> statement-breakpoint
CREATE INDEX "media_cache_post_plans_state_idx" ON "media_cache_post_plans" USING btree ("state","id");--> statement-breakpoint
CREATE INDEX "media_cache_post_plans_lease_expiry_idx" ON "media_cache_post_plans" USING btree ("lease_expires_at","id") WHERE "media_cache_post_plans"."state" in ('reserved', 'staging', 'settling', 'recovering');--> statement-breakpoint
CREATE INDEX "message_source_media_observations_discovery_idx" ON "message_source_media_observations" USING btree ("created_at","id");
