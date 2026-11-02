import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

/**
 * Single environment loader for every non-Next entry point.
 *
 * Next.js loads `.env*` files itself at runtime, so `src/lib/env.ts` keeps
 * reading `process.env` and is deliberately left untouched. Everything that
 * runs outside that runtime (`prisma.config.ts`, `scripts/*`, tests) goes
 * through this module so there is exactly one loading implementation.
 *
 * Precedence, highest first:
 *   1. the real process environment (shell, CI, container) — never overridden
 *   2. `.env.local` — overrides `.env`
 *   3. `.env`
 *
 * That matches what Next.js does (`process.env` wins over files, `.env.local`
 * wins over `.env`), so the CLI, scripts and the app agree.
 *
 * Paths are resolved against the repository root derived from this module's
 * location, never `process.cwd()`: `node scripts/x.mjs` from any directory
 * still finds the same files.
 */

/** Repository root, resolved from this file (`src/lib/` → up two levels). */
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Base file first, local override second. */
export const DEFAULT_ENV_FILES = [".env", ".env.local"] as const;

export type LoadEnvironmentOptions = {
  /** Directory containing the env files. Defaults to the repository root. */
  root?: string;
  /** File names in ascending precedence. Defaults to `.env`, `.env.local`. */
  files?: readonly string[];
  /** Target map. Defaults to `process.env`. Overridden only for tests. */
  env?: Record<string, string | undefined>;
};

export type LoadedEnvironment = {
  root: string;
  loaded: readonly string[];
  missing: readonly string[];
};

/**
 * Loads the env files into `env`, honouring precedence. Missing files are not
 * an error: every caller still has to cope with unset credentials.
 */
export function loadEnvironment(options: LoadEnvironmentOptions = {}): LoadedEnvironment {
  const root = options.root ?? PROJECT_ROOT;
  const env = options.env ?? process.env;
  const files = options.files ?? DEFAULT_ENV_FILES;

  // Snapshot the ambient environment first: anything already set (shell, CI)
  // must win over every file.
  const ambient = new Set(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  );

  const loaded: string[] = [];
  const missing: string[] = [];

  for (const name of files) {
    const file = path.resolve(root, name);
    if (!existsSync(file)) {
      missing.push(name);
      continue;
    }

    const values = parse(readFileSync(file));
    for (const [key, value] of Object.entries(values)) {
      // Not ambient ⇒ a previous file set it (later file wins) or nobody did.
      if (!ambient.has(key)) {
        env[key] = value;
      }
    }
    loaded.push(name);
  }

  return { root, loaded, missing };
}
