-- AI-GPR remains a stored reference. Brent is the timely closing factor used by the model.
ALTER TABLE "DailyRiskData" ADD COLUMN IF NOT EXISTS "brent" DOUBLE PRECISION;
ALTER TABLE "DailyRiskData" ADD COLUMN IF NOT EXISTS "brentZ" DOUBLE PRECISION;

-- Existing rows predate the Brent model. Keep them queryable until the next full history refresh.
UPDATE "DailyRiskData" SET "brent" = 0 WHERE "brent" IS NULL;
UPDATE "DailyRiskData" SET "brentZ" = 0 WHERE "brentZ" IS NULL;
ALTER TABLE "DailyRiskData" ALTER COLUMN "brent" SET NOT NULL;
ALTER TABLE "DailyRiskData" ALTER COLUMN "brentZ" SET NOT NULL;
