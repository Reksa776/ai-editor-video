/**
 * Credential redaction for anything printed to a terminal or a log.
 *
 * Database drivers quote the failing user and table but not the password;
 * nevertheless every message that leaves a script goes through here, so a
 * driver that does echo a DSN, or a future `throw` that includes one, cannot
 * leak it.
 */

/** `mysql://user:pass@host/db`, `mysql+pymysql://…`, etc. */
const DSN_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi;

/** `password=hunter2`, `passwd: hunter2`, `pwd=…`. */
const KEY_VALUE_PATTERN = /\b(password|passwd|pwd)\s*[=:]\s*\S+/gi;

/** Replaces every connection string and inline password with a placeholder. */
export function redactSecrets(text: string): string {
  return text
    .replace(DSN_PATTERN, (match) => `${match.slice(0, match.indexOf("://"))}://<redacted>`)
    .replace(KEY_VALUE_PATTERN, (_match, key: string) => `${key}=<redacted>`);
}
