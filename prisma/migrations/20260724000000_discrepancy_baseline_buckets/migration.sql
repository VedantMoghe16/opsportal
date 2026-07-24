-- CreateEnum
CREATE TYPE "DiscrepancyType" AS ENUM ('SHORT_RECEIPT', 'EXCESS_RECEIPT', 'CHANNEL_REJECTION');

-- CreateEnum
CREATE TYPE "DiscrepancyBaseline" AS ENUM ('DISPATCHED', 'ASSIGNED', 'ORDERED');

-- CreateEnum
CREATE TYPE "DiscrepancyOrigin" AS ENUM ('LIVE', 'BACKFILL');

-- AlterTable
ALTER TABLE "Discrepancy" ADD COLUMN     "baseline" "DiscrepancyBaseline",
ADD COLUMN     "baselineQty" INTEGER,
ADD COLUMN     "origin" "DiscrepancyOrigin" NOT NULL DEFAULT 'LIVE',
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "type" "DiscrepancyType" NOT NULL DEFAULT 'SHORT_RECEIPT',
ADD COLUMN     "valueImpact" DOUBLE PRECISION;

