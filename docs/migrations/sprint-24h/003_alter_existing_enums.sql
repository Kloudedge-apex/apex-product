-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OutreachArtifactStatus" ADD VALUE 'QUEUED';
ALTER TYPE "OutreachArtifactStatus" ADD VALUE 'REPLIED';
ALTER TYPE "OutreachArtifactStatus" ADD VALUE 'BOUNCED';
ALTER TYPE "OutreachArtifactStatus" ADD VALUE 'SUPPRESSED';

-- AlterEnum
ALTER TYPE "EmailEventKind" ADD VALUE 'SUPPRESSED';

