CREATE TABLE "edit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"user_id" uuid,
	"source" text NOT NULL,
	"origin" text,
	"inserted_chars" integer DEFAULT 0 NOT NULL,
	"deleted_chars" integer DEFAULT 0 NOT NULL,
	"inserted_lines" integer DEFAULT 0 NOT NULL,
	"deleted_lines" integer DEFAULT 0 NOT NULL,
	"from_line" integer,
	"to_line" integer,
	"started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edit_log" ADD CONSTRAINT "edit_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_log" ADD CONSTRAINT "edit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edit_log_project_idx" ON "edit_log" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "edit_log_file_idx" ON "edit_log" USING btree ("file_id","created_at");