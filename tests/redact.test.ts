import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../src/lib/redact";

test("redacts connection strings but keeps the scheme", () => {
  const message = "failed to connect: mysql://aivideo_web:s3cr3t@localhost:3306/aivideo";
  const redacted = redactSecrets(message);

  assert.equal(redacted.includes("s3cr3t"), false);
  assert.equal(redacted.includes("aivideo_web"), false);
  assert.match(redacted, /mysql:\/\/<redacted>/);
});

test("redacts percent-encoded and generated passwords inside DSNs", () => {
  const redacted = redactSecrets("mysql://user:p%40ss%2Fword@localhost/aivideo and mysql+pymysql://u:p@h/d");
  assert.equal(redacted.includes("p%40ss"), false);
  assert.equal(redacted.includes(":p@h"), false);
  assert.match(redacted, /mysql\+pymysql:\/\/<redacted>/);
});

test("redacts key/value password forms", () => {
  const redacted = redactSecrets("connection password=hunter2 rejected; pwd: swordfish");
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("swordfish"), false);
  assert.match(redacted, /password=<redacted>/);
  assert.match(redacted, /pwd=<redacted>/);
});

test("leaves ordinary errors intact", () => {
  assert.equal(redactSecrets("UPDATE command denied to user 'aivideo_web'@'localhost'"),
    "UPDATE command denied to user 'aivideo_web'@'localhost'");
});
