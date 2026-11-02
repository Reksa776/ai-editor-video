import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECT_ROOT, loadEnvironment } from "../src/lib/env-loader";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "aivideo-env-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(root, name), body, "utf8");
  }
  return root;
}

test("loads .env.local and lets it override .env", async () => {
  const root = await fixture({
    ".env": "WEB_DATABASE_URL=mysql://base:base@localhost:3306/aivideo\nAPP_ENV=base\n",
    ".env.local": "WEB_DATABASE_URL=mysql://local:local@localhost:3306/aivideo\n",
  });
  try {
    const env: Record<string, string | undefined> = {};
    const result = loadEnvironment({ root, env });

    assert.equal(env.WEB_DATABASE_URL, "mysql://local:local@localhost:3306/aivideo");
    assert.equal(env.APP_ENV, "base", "keys only present in .env must still load");
    assert.deepEqual(result.loaded, [".env", ".env.local"]);
    assert.deepEqual(result.missing, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to .env when .env.local is missing", async () => {
  const root = await fixture({ ".env": "WEB_DATABASE_URL=mysql://base:base@localhost:3306/aivideo\n" });
  try {
    const env: Record<string, string | undefined> = {};
    const result = loadEnvironment({ root, env });

    assert.equal(env.WEB_DATABASE_URL, "mysql://base:base@localhost:3306/aivideo");
    assert.deepEqual(result.loaded, [".env"]);
    assert.deepEqual(result.missing, [".env.local"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the shell environment always wins over env files", async () => {
  const root = await fixture({
    ".env": "WEB_DATABASE_URL=mysql://base:base@localhost:3306/aivideo\n",
    ".env.local": "WEB_DATABASE_URL=mysql://local:local@localhost:3306/aivideo\n",
  });
  try {
    const env: Record<string, string | undefined> = {
      WEB_DATABASE_URL: "mysql://shell:shell@db.internal:3306/aivideo",
    };
    loadEnvironment({ root, env });

    assert.equal(env.WEB_DATABASE_URL, "mysql://shell:shell@db.internal:3306/aivideo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing WEB_DATABASE_URL is not an error", async () => {
  const root = await fixture({ ".env.example": "WEB_DATABASE_URL=mysql://template/template@localhost/aivideo\n" });
  try {
    const env: Record<string, string | undefined> = {};
    const result = loadEnvironment({ root, env });

    assert.equal(env.WEB_DATABASE_URL, undefined);
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.missing, [".env", ".env.local"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves the default root from the module, not the cwd", () => {
  assert.ok(path.isAbsolute(PROJECT_ROOT));
  assert.ok(existsSync(path.join(PROJECT_ROOT, "package.json")), "PROJECT_ROOT must be the repo root");
  assert.equal(loadEnvironment({ env: {} }).root, PROJECT_ROOT);
});
