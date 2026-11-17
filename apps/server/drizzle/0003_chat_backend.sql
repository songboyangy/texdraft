ALTER TABLE "chat_threads" ADD COLUMN "backend" text DEFAULT 'builtin' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "cli_session" text;