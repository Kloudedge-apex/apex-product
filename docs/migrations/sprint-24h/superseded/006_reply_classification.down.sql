-- DropForeignKey
ALTER TABLE "ReplyClassification" DROP CONSTRAINT "ReplyClassification_orgId_fkey";

-- DropForeignKey
ALTER TABLE "ReplyClassification" DROP CONSTRAINT "ReplyClassification_replyId_fkey";

-- DropTable
DROP TABLE "ReplyClassification";

