-- DropIndex
DROP INDEX "Contact_workspaceId_email_idx";

-- DropIndex
DROP INDEX "Contact_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "Contact_workspaceId_email_key" ON "Contact"("workspaceId", "email");
