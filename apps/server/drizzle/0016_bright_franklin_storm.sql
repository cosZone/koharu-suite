ALTER TABLE "media_cache_commands" DROP CONSTRAINT "media_cache_commands_operation_check";--> statement-breakpoint
ALTER TABLE "media_cache_commands" DROP CONSTRAINT "media_cache_commands_target_check";--> statement-breakpoint
ALTER TABLE "media_cache_commands" ADD COLUMN "source_backend_id" varchar(64);--> statement-breakpoint
ALTER TABLE "media_cache_commands" ADD COLUMN "target_backend_id" varchar(64);--> statement-breakpoint
ALTER TABLE "media_cache_commands" ADD COLUMN "target_bytes" bigint;--> statement-breakpoint
ALTER TABLE "media_cache_commands" ADD CONSTRAINT "media_cache_commands_source_backend_id_media_storage_backends_id_fk" FOREIGN KEY ("source_backend_id") REFERENCES "public"."media_storage_backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_cache_commands" ADD CONSTRAINT "media_cache_commands_target_backend_id_media_storage_backends_id_fk" FOREIGN KEY ("target_backend_id") REFERENCES "public"."media_storage_backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_cache_commands_backend_idx" ON "media_cache_commands" USING btree ("target_backend_id","created_at","id");--> statement-breakpoint
ALTER TABLE "media_cache_commands" ADD CONSTRAINT "media_cache_commands_operation_check" CHECK ("media_cache_commands"."operation" in ('evict', 'migrate', 'prune', 'reconcile', 'restore'));--> statement-breakpoint
ALTER TABLE "media_cache_commands" ADD CONSTRAINT "media_cache_commands_target_check" CHECK ((
          "media_cache_commands"."operation" = 'evict'
          and "media_cache_commands"."object_id" is not null
          and "media_cache_commands"."source_backend_id" is null
          and "media_cache_commands"."target_backend_id" is null
          and "media_cache_commands"."target_bytes" is null
        ) or (
          "media_cache_commands"."operation" = 'reconcile'
          and "media_cache_commands"."object_id" is null
          and "media_cache_commands"."source_backend_id" is null
          and "media_cache_commands"."target_backend_id" is null
          and "media_cache_commands"."target_bytes" is null
        ) or (
          "media_cache_commands"."operation" = 'migrate'
          and "media_cache_commands"."source_backend_id" is not null
          and "media_cache_commands"."target_backend_id" is not null
          and "media_cache_commands"."source_backend_id" <> "media_cache_commands"."target_backend_id"
          and "media_cache_commands"."target_bytes" is null
        ) or (
          "media_cache_commands"."operation" = 'restore'
          and "media_cache_commands"."object_id" is not null
          and "media_cache_commands"."source_backend_id" is null
          and "media_cache_commands"."target_backend_id" is not null
          and "media_cache_commands"."target_bytes" is null
        ) or (
          "media_cache_commands"."operation" = 'prune'
          and "media_cache_commands"."object_id" is null
          and "media_cache_commands"."source_backend_id" is null
          and "media_cache_commands"."target_backend_id" is not null
          and "media_cache_commands"."target_bytes" is not null
          and "media_cache_commands"."target_bytes" >= 0
        ));