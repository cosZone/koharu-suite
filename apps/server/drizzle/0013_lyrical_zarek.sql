CREATE TABLE "media_blob_locations" (
	"backend_id" varchar(64) NOT NULL,
	"blob_sha256" char(64) NOT NULL,
	"storage_key" text NOT NULL,
	"state" varchar(16) NOT NULL,
	"verified_byte_length" bigint,
	"verified_sha256" char(64),
	"provider_etag" varchar(1024),
	"provider_version_id" varchar(1024),
	"provider_checksum_sha256" varchar(128),
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mutation_owner" text,
	"mutation_token" uuid,
	"mutation_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_blob_locations_pk" PRIMARY KEY("backend_id","blob_sha256"),
	CONSTRAINT "media_blob_locations_storage_key_check" CHECK ("media_blob_locations"."storage_key"
        = 'blobs/' || substr("media_blob_locations"."blob_sha256", 1, 2)
          || '/' || substr("media_blob_locations"."blob_sha256", 3, 2)
          || '/' || "media_blob_locations"."blob_sha256"),
	CONSTRAINT "media_blob_locations_state_check" CHECK ("media_blob_locations"."state" in ('copying', 'ready', 'deleting', 'evicted', 'missing', 'corrupt')),
	CONSTRAINT "media_blob_locations_verification_check" CHECK ((
          "media_blob_locations"."verified_byte_length" is null
          and "media_blob_locations"."verified_sha256" is null
          and "media_blob_locations"."verified_at" is null
        ) or (
          "media_blob_locations"."verified_byte_length" > 0
          and "media_blob_locations"."verified_sha256" = "media_blob_locations"."blob_sha256"
          and "media_blob_locations"."verified_at" is not null
        )),
	CONSTRAINT "media_blob_locations_ready_check" CHECK ("media_blob_locations"."state" <> 'ready'
        or (
          "media_blob_locations"."verified_byte_length" is not null
          and "media_blob_locations"."verified_sha256" is not null
          and "media_blob_locations"."verified_at" is not null
        )),
	CONSTRAINT "media_blob_locations_provider_metadata_check" CHECK (("media_blob_locations"."provider_etag" is null or length("media_blob_locations"."provider_etag") between 1 and 1024)
        and ("media_blob_locations"."provider_version_id" is null or length("media_blob_locations"."provider_version_id") between 1 and 1024)
        and (
          "media_blob_locations"."provider_checksum_sha256" is null
          or length("media_blob_locations"."provider_checksum_sha256") between 1 and 128
        )),
	CONSTRAINT "media_blob_locations_mutation_lease_check" CHECK ((
          "media_blob_locations"."state" in ('copying', 'deleting')
          and "media_blob_locations"."mutation_owner" is not null
          and length(btrim("media_blob_locations"."mutation_owner")) between 1 and 255
          and "media_blob_locations"."mutation_token" is not null
          and "media_blob_locations"."mutation_expires_at" is not null
        ) or (
          "media_blob_locations"."state" not in ('copying', 'deleting')
          and "media_blob_locations"."mutation_owner" is null
          and "media_blob_locations"."mutation_token" is null
          and "media_blob_locations"."mutation_expires_at" is null
        ))
);
--> statement-breakpoint
CREATE TABLE "media_cache_object_protections" (
	"object_id" uuid PRIMARY KEY NOT NULL,
	"owner_kind" varchar(32) NOT NULL,
	"owner_id" text NOT NULL,
	"reason" text NOT NULL,
	"protected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_cache_object_protections_owner_check" CHECK ("media_cache_object_protections"."owner_kind" in ('local_operator', 'owner_session')
        and length(btrim("media_cache_object_protections"."owner_id")) between 1 and 255),
	CONSTRAINT "media_cache_object_protections_reason_check" CHECK (length(btrim("media_cache_object_protections"."reason")) between 1 and 500),
	CONSTRAINT "media_cache_object_protections_expiry_check" CHECK ("media_cache_object_protections"."expires_at" is null or "media_cache_object_protections"."expires_at" > "media_cache_object_protections"."protected_at")
);
--> statement-breakpoint
CREATE TABLE "media_storage_backends" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"kind" varchar(16) NOT NULL,
	"label" varchar(128) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"readable" boolean DEFAULT true NOT NULL,
	"writable" boolean DEFAULT true NOT NULL,
	"read_priority" integer DEFAULT 100 NOT NULL,
	"write_priority" integer DEFAULT 100 NOT NULL,
	"max_bytes" bigint NOT NULL,
	"ready_bytes" bigint DEFAULT 0 NOT NULL,
	"config_fingerprint" char(64) NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_storage_backends_id_check" CHECK ("media_storage_backends"."id" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "media_storage_backends_kind_check" CHECK ("media_storage_backends"."kind" in ('local', 's3')),
	CONSTRAINT "media_storage_backends_label_check" CHECK (length(btrim("media_storage_backends"."label")) between 1 and 128),
	CONSTRAINT "media_storage_backends_capabilities_check" CHECK (not "media_storage_backends"."enabled" or "media_storage_backends"."readable" or "media_storage_backends"."writable"),
	CONSTRAINT "media_storage_backends_priority_check" CHECK ("media_storage_backends"."read_priority" between 0 and 1000000
        and "media_storage_backends"."write_priority" between 0 and 1000000),
	CONSTRAINT "media_storage_backends_ledger_check" CHECK ("media_storage_backends"."max_bytes" > 0
        and "media_storage_backends"."ready_bytes" >= 0),
	CONSTRAINT "media_storage_backends_fingerprint_check" CHECK ("media_storage_backends"."config_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "media_cache_actions" DROP CONSTRAINT "media_cache_actions_kind_check";--> statement-breakpoint
ALTER TABLE "media_cache_objects" ADD COLUMN "evicted_policy" varchar(32) DEFAULT 'recache_on_access' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_blob_locations" ADD CONSTRAINT "media_blob_locations_backend_id_media_storage_backends_id_fk" FOREIGN KEY ("backend_id") REFERENCES "public"."media_storage_backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_blob_locations" ADD CONSTRAINT "media_blob_locations_blob_sha256_media_cache_blobs_sha256_fk" FOREIGN KEY ("blob_sha256") REFERENCES "public"."media_cache_blobs"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_cache_object_protections" ADD CONSTRAINT "media_cache_object_protections_object_id_media_cache_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."media_cache_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_blob_locations_blob_state_idx" ON "media_blob_locations" USING btree ("blob_sha256","state","backend_id");--> statement-breakpoint
CREATE INDEX "media_blob_locations_lru_idx" ON "media_blob_locations" USING btree ("backend_id","last_accessed_at","blob_sha256") WHERE "media_blob_locations"."state" = 'ready';--> statement-breakpoint
CREATE INDEX "media_blob_locations_mutation_expiry_idx" ON "media_blob_locations" USING btree ("mutation_expires_at","backend_id","blob_sha256") WHERE "media_blob_locations"."state" in ('copying', 'deleting');--> statement-breakpoint
CREATE INDEX "media_cache_object_protections_expiry_idx" ON "media_cache_object_protections" USING btree ("expires_at","object_id") WHERE "media_cache_object_protections"."expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "media_storage_backends_local_unique" ON "media_storage_backends" USING btree ("kind") WHERE "media_storage_backends"."kind" = 'local';--> statement-breakpoint
CREATE INDEX "media_storage_backends_read_idx" ON "media_storage_backends" USING btree ("read_priority","id") WHERE "media_storage_backends"."enabled" and "media_storage_backends"."readable";--> statement-breakpoint
CREATE INDEX "media_storage_backends_write_idx" ON "media_storage_backends" USING btree ("write_priority","id") WHERE "media_storage_backends"."enabled" and "media_storage_backends"."writable";--> statement-breakpoint
ALTER TABLE "media_cache_blobs" ADD CONSTRAINT "media_cache_blobs_verified_identity_unique" UNIQUE("sha256","byte_length");--> statement-breakpoint
ALTER TABLE "media_cache_actions" ADD CONSTRAINT "media_cache_actions_kind_check" CHECK ("media_cache_actions"."action_kind" in (
        'retry',
        'evict',
        'migrate',
        'restore',
        'protect',
        'unprotect',
        'prune',
        'reconcile',
        'recover_orphan',
        'restore_missing'
      ));--> statement-breakpoint
ALTER TABLE "media_cache_objects" ADD CONSTRAINT "media_cache_objects_evicted_policy_check" CHECK ("media_cache_objects"."evicted_policy" in ('recache_on_access', 'stay_evicted'));