#!/usr/bin/env node
/**
 * `npm run db:migrate:dev -- --name <migration_name>`
 *
 * Runs `prisma migrate dev` with every forwarded argument, then regenerates
 * the Prisma Client (v7 removed the automatic generate step from `migrate dev`).
 *
 * Why this script exists:
 *   With the previous shell string `prisma migrate dev && prisma generate`,
 *   npm appends script arguments to the END of the whole line, so `--name init`
 *   was delivered to `prisma generate` instead of `prisma migrate dev`.
 *   Forwarding from a Node script keeps arguments attached to the command they
 *   belong to, and works the same on Linux, macOS and Windows (no `sh -c`).
 *
 * Safety:
 *   MIGRATE_DEV_DRY_RUN=1 prints the exact commands without executing them.
 *   This is how the argument forwarding is verified without touching a database.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

// Resolve the local Prisma CLI and run it with the current Node binary, so no
// PATH lookup or .cmd/.bat shell wrapper is involved.
const prismaPkgPath = require.resolve("prisma/package.json");
const prismaCli = join(dirname(prismaPkgPath), require(prismaPkgPath).bin.prisma);

const forwarded = process.argv.slice(2);

/** @type {Array<{ args: string[] }>} */
const steps = [
  { args: ["migrate", "dev", ...forwarded] },
  { args: ["generate"] },
];

const label = (args) => `prisma ${args.join(" ")}`;

if (process.env.MIGRATE_DEV_DRY_RUN === "1") {
  for (const step of steps) console.log(`[dry-run] ${label(step.args)}`);
  process.exit(0);
}

for (const step of steps) {
  console.log(`\n$ ${label(step.args)}`);
  const result = spawnSync(process.execPath, [prismaCli, ...step.args], {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`\nCould not run ${label(step.args)}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n${label(step.args)} failed (${result.status ?? result.signal}).`);
    process.exit(typeof result.status === "number" ? result.status : 1);
  }
}
