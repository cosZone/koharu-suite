ALTER TABLE "media_cache_commands" DROP CONSTRAINT "media_cache_commands_initiator_kind_check";--> statement-breakpoint
CREATE UNIQUE INDEX "media_cache_commands_active_restore_unique" ON "media_cache_commands" USING btree ("object_id","target_backend_id") WHERE "media_cache_commands"."operation" = 'restore'
          and "media_cache_commands"."initiator_kind" = 'worker'
          and "media_cache_commands"."state" in ('pending', 'running');--> statement-breakpoint
ALTER TABLE "media_cache_commands" ADD CONSTRAINT "media_cache_commands_initiator_kind_check" CHECK ((
        "media_cache_commands"."initiator_kind" in ('local_operator', 'owner_session')
        or ("media_cache_commands"."initiator_kind" = 'worker' and "media_cache_commands"."operation" = 'restore')
      ));