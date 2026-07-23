CREATE TABLE "message_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" varchar(32) NOT NULL,
	"telegram_file_id" text NOT NULL,
	"telegram_file_unique_id" text NOT NULL,
	"mime_type" text,
	"file_name" text,
	"file_size" bigint,
	"width" integer,
	"height" integer,
	"duration" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"telegram_update_id" bigint NOT NULL,
	"revision_number" integer NOT NULL,
	"content_kind" varchar(16) NOT NULL,
	"text" text,
	"entities" jsonb NOT NULL,
	"author_signature" text,
	"media_group_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"current_revision_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"title" text NOT NULL,
	"username" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"telegram_update_id" bigint PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"update_type" varchar(32) NOT NULL,
	"raw_json" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_revision_id_message_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."message_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_telegram_update_id_telegram_updates_telegram_update_id_fk" FOREIGN KEY ("telegram_update_id") REFERENCES "public"."telegram_updates"("telegram_update_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_telegram_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."telegram_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_channel_id_telegram_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."telegram_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_media_revision_position_unique" ON "message_media" USING btree ("revision_id","position");--> statement-breakpoint
CREATE INDEX "message_media_revision_idx" ON "message_media" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_revisions_message_number_unique" ON "message_revisions" USING btree ("message_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "message_revisions_update_unique" ON "message_revisions" USING btree ("telegram_update_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_message_unique" ON "messages" USING btree ("channel_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "messages_channel_published_idx" ON "messages" USING btree ("channel_id","published_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_channels_chat_id_unique" ON "telegram_channels" USING btree ("telegram_chat_id");--> statement-breakpoint
CREATE INDEX "telegram_updates_channel_received_idx" ON "telegram_updates" USING btree ("channel_id","received_at");