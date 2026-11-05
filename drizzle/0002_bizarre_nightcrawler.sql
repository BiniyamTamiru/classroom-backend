ALTER TABLE "classes" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "capacity" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "banner_cld_pub_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "imageCldpubId" text;--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "image_cld_pub_id";