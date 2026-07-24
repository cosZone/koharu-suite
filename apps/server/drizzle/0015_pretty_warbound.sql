ALTER TABLE "media_cache_actions" DROP CONSTRAINT "media_cache_actions_kind_check";--> statement-breakpoint
ALTER TABLE "media_cache_actions" ADD CONSTRAINT "media_cache_actions_kind_check" CHECK ("media_cache_actions"."action_kind" in (
        'retry',
        'evict',
        'migrate',
        'restore',
        'protect',
        'unprotect',
        'prune',
        'set_evicted_policy',
        'reconcile',
        'recover_orphan',
        'restore_missing'
      ));