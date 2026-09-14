CREATE TYPE "public"."fleet_provenance" AS ENUM('placeholder', 'operator_confirmed');--> statement-breakpoint
CREATE TYPE "public"."vehicle_category" AS ENUM('exotic', 'luxury', 'suv', 'sports', 'convertible', 'sedan');--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"make" text NOT NULL,
	"model" text NOT NULL,
	"variant" text,
	"year" integer NOT NULL,
	"colour" text NOT NULL,
	"category" "vehicle_category" NOT NULL,
	"plate" text NOT NULL,
	"chassis_number" text NOT NULL,
	"engine" text,
	"power_hp" integer,
	"transmission" text,
	"drivetrain" text,
	"seats" integer,
	"doors" integer,
	"odometer_km" integer,
	"active" boolean DEFAULT true NOT NULL,
	"inactive_reason" text,
	"provenance" "fleet_provenance" DEFAULT 'placeholder' NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_operator_plate_key" UNIQUE("operator_id","plate"),
	CONSTRAINT "vehicles_operator_chassis_key" UNIQUE("operator_id","chassis_number"),
	CONSTRAINT "vehicles_id_operator_key" UNIQUE("id","operator_id")
);
--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_confirmed_by_operator_fkey" FOREIGN KEY ("confirmed_by_membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vehicles_operator_active_idx" ON "vehicles" USING btree ("operator_id","active");--> statement-breakpoint
CREATE INDEX "vehicles_operator_make_model_idx" ON "vehicles" USING btree ("operator_id","make","model");