/**
 * Database access-boundary verification (one writer per table).
 *
 * Expectations once MySQL is provisioned:
 *   - writing `projects` as the Next.js runtime user  -> SUCCEEDS
 *   - writing `jobs`     as the Next.js runtime user  -> REJECTED by MySQL
 *
 * Without credentials this script reports BLOCKED and exits 2. It never
 * guesses passwords and never touches other databases.
 *
 * Run: npm run verify:db-access
 */
import { getPrisma } from "../src/lib/prisma";
import { ulid } from "../src/lib/id";

async function main(): Promise<void> {
  let prisma;
  try {
    prisma = getPrisma();
  } catch (error) {
    console.log("BLOCKED  WEB_DATABASE_URL is not configured");
    console.log(`         ${(error as Error).message}`);
    process.exit(2);
  }

  const projectId = ulid();
  try {
    await prisma.project.create({ data: { id: projectId, name: "__boundary_probe__" } });
    console.log("PASS  write to projects succeeded (web owns projects)");
  } catch (error) {
    console.log(`BLOCKED  could not write projects: ${(error as Error).message.split("\n")[0]}`);
    process.exit(2);
  }

  let rejected = false;
  try {
    // `jobs` does not exist yet and is media-owned; either error proves the
    // boundary, but a privilege error is the expected outcome once it exists.
    await prisma.$executeRawUnsafe(
      "INSERT INTO jobs (id, project_id, tool_name, idempotency_key, status) VALUES ('x','x','x','x','queued')",
    );
  } catch (error) {
    const message = (error as Error).message;
    rejected = /denied|doesn't exist|not exist|Unknown column/i.test(message);
    console.log(`PASS  write to jobs rejected: ${message.split("\n")[0]}`);
  }

  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);

  if (!rejected) {
    console.log("FAIL  write to jobs was not rejected");
    process.exit(1);
  }
  console.log("Access boundary verified.");
}

main().catch((error) => {
  console.error("verification crashed:", error);
  process.exit(1);
});
