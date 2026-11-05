ALTER TABLE "classes" DROP CONSTRAINT "classes_subject_id_subjects_id_fk";
--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_code_lower_unique" ON "subjects" USING btree (lower("code"));