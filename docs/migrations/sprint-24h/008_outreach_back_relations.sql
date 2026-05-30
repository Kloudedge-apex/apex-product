-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "OutreachArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmRequestFact" ADD CONSTRAINT "LlmRequestFact_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "OutreachArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

