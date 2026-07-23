-- AI-GPR remains a stored reference. Brent is the timely closing factor used by the model.
ALTER TABLE "DailyRiskData" ADD COLUMN IF NOT EXISTS "brent" DOUBLE PRECISION;
ALTER TABLE "DailyRiskData" ADD COLUMN IF NOT EXISTS "brentZ" DOUBLE PRECISION;
ALTER TABLE "DailyRiskData" ADD COLUMN IF NOT EXISTS "oilSpread" DOUBLE PRECISION;
ALTER TABLE "DailyRiskData" ADD COLUMN IF NOT EXISTS "oilIv" DOUBLE PRECISION;
ALTER TABLE "DailyRiskData" ADD COLUMN IF NOT EXISTS "goldOilRatio" DOUBLE PRECISION;
ALTER TABLE "DailyRiskData" ADD COLUMN IF NOT EXISTS "oilSpreadZ" DOUBLE PRECISION;
ALTER TABLE "DailyRiskData" ADD COLUMN IF NOT EXISTS "oilIvZ" DOUBLE PRECISION;
ALTER TABLE "DailyRiskData" ADD COLUMN IF NOT EXISTS "goldOilZ" DOUBLE PRECISION;
ALTER TABLE "DailyRiskData" ADD COLUMN IF NOT EXISTS "marketTransmissionZ" DOUBLE PRECISION;

-- Existing rows predate the Brent model. Keep them queryable until the next full history refresh.
UPDATE "DailyRiskData" SET "brent" = 0 WHERE "brent" IS NULL;
UPDATE "DailyRiskData" SET "brentZ" = 0 WHERE "brentZ" IS NULL;
UPDATE "DailyRiskData" SET "oilSpread" = 0 WHERE "oilSpread" IS NULL;
UPDATE "DailyRiskData" SET "oilIv" = 0 WHERE "oilIv" IS NULL;
UPDATE "DailyRiskData" SET "goldOilRatio" = 0 WHERE "goldOilRatio" IS NULL;
UPDATE "DailyRiskData" SET "oilSpreadZ" = 0 WHERE "oilSpreadZ" IS NULL;
UPDATE "DailyRiskData" SET "oilIvZ" = 0 WHERE "oilIvZ" IS NULL;
UPDATE "DailyRiskData" SET "goldOilZ" = 0 WHERE "goldOilZ" IS NULL;
UPDATE "DailyRiskData" SET "marketTransmissionZ" = 0 WHERE "marketTransmissionZ" IS NULL;
ALTER TABLE "DailyRiskData" ALTER COLUMN "brent" SET NOT NULL;
ALTER TABLE "DailyRiskData" ALTER COLUMN "brentZ" SET NOT NULL;
ALTER TABLE "DailyRiskData" ALTER COLUMN "oilSpread" SET NOT NULL;
ALTER TABLE "DailyRiskData" ALTER COLUMN "oilIv" SET NOT NULL;
ALTER TABLE "DailyRiskData" ALTER COLUMN "goldOilRatio" SET NOT NULL;
ALTER TABLE "DailyRiskData" ALTER COLUMN "oilSpreadZ" SET NOT NULL;
ALTER TABLE "DailyRiskData" ALTER COLUMN "oilIvZ" SET NOT NULL;
ALTER TABLE "DailyRiskData" ALTER COLUMN "goldOilZ" SET NOT NULL;
ALTER TABLE "DailyRiskData" ALTER COLUMN "marketTransmissionZ" SET NOT NULL;
