# PHASE 1 — PRIVILEGE ROOT-CAUSE AUDIT

Date: 2026-11-02
Subject: `'aivideo_web'@'localhost'` — why UPDATE/DELETE are allowed and why the isolation check fails.
Target database: `aivideo`. Server: MariaDB 11.8.8 on `localhost:3306`.

**Read-only.** No GRANT/REVOKE, no UPDATE/DELETE/INSERT, no schema or migration change, no credential change, no code change, no deployment, no commit. `npm run verify:db-access` was **not** run. Phase 2 not started.

---

## 1. Executive summary

| Question | Answer |
| --- | --- |
| Why is UPDATE allowed? | A **global** grant: `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE ON *.* … WITH GRANT OPTION` |
| Why is DELETE allowed? | The same global grant |
| Are the table-level grants wrong? | **No** — `aivideo.projects` and `aivideo.assets` have exactly `SELECT, INSERT`, as intended |
| Database-level grants? | None (`mysql.db` has no rows for this account) |
| Column-level grants? | None (`mysql.columns_priv` empty) |
| Roles / default roles? | None (`CURRENT_ROLE()` NULL, `ENABLED_ROLES` empty, `mysql.roles_mapping` empty) |
| Is the isolation FAIL a false positive? | **No** — correct in method *and* outcome here; see §6 |
| Severity | **Critical** — the runtime account can read/write/delete every application database on the server, read `mysql.user` (password hashes), create databases, and grant privileges onward |

The defect is one extra line added at the server level. Nothing in the schema, the Prisma config, or the application is responsible.

---

## 2. Evidence — every privilege source, enumerated

Executed as `aivideo_web@localhost`, plus a cross-check as `aivideo_migrator@localhost` (read-only statements only).

### 2.1 `SHOW GRANTS FOR CURRENT_USER()` — the whole answer

```
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE ON *.* TO `aivideo_web`@`localhost`
      IDENTIFIED BY PASSWORD '<hash omitted>' WITH GRANT OPTION

GRANT SELECT, INSERT ON `aivideo`.`assets`   TO `aivideo_web`@`localhost`
GRANT SELECT, INSERT ON `aivideo`.`projects` TO `aivideo_web`@`localhost`
```

`SHOW GRANTS FOR 'aivideo_web'@'localhost'` returns exactly the same three lines, so reading one's own grants is complete here — nothing is hidden behind a role.

### 2.2 Attribution table — which layer grants what

| Layer | Source queried | Result for `aivideo_web` |
| --- | --- | --- |
| Global | `information_schema.USER_PRIVILEGES` / `mysql.user` | `SELECT, INSERT, UPDATE, DELETE, CREATE` on `*.*`, **grantable = YES** |
| Database | `information_schema.SCHEMA_PRIVILEGES` / `mysql.db` | **none** |
| Table | `information_schema.TABLE_PRIVILEGES` / `mysql.tables_priv` | `aivideo.projects` → `Select,Insert`; `aivideo.assets` → `Select,Insert` |
| Column | `information_schema.COLUMN_PRIVILEGES` / `mysql.columns_priv` | **none** |
| Role | `CURRENT_ROLE()`, `ENABLED_ROLES`, `APPLICABLE_ROLES`, `mysql.roles_mapping` | `NULL`, empty, empty, empty → **no role path** |
| Dynamic privileges | `mysql.global_grants` | table absent on MariaDB 11.8 (privileges live in `mysql.global_priv`) → no separate source |
| Other accounts with the same name | `mysql.user WHERE user='aivideo_web'` | exactly one row: `aivideo_web@localhost` |
| Anonymous accounts that could shadow | `mysql.user WHERE user=''` | none |

Raw rows (hashes omitted):

```
mysql.user  : aivideo_web | localhost | is_role=N | default_role='' | Grant_priv=Y | Super_priv=N | Create_priv=Y | Drop_priv=N | Update_priv=Y | Delete_priv=Y
mysql.db    : (no rows)
mysql.tables_priv : localhost | aivideo | aivideo_web | projects | Select,Insert |
                    localhost | aivideo | aivideo_web | assets   | Select,Insert |
```

`Grant_priv=Y` corroborates the `WITH GRANT OPTION` in `SHOW GRANTS`.

### 2.3 Why the table grants never took effect

MySQL/MariaDB privileges are **additive**: the effective privilege set is the union of global, database, table and column grants. `GRANT SELECT, INSERT ON aivideo.projects` does not remove `UPDATE`/`DELETE` already granted on `*.*`. The table-level grants are correct and were presumably applied to tighten access, but the pre-existing global grant keeps UPDATE/DELETE (and CREATE, and every other schema) in force.

That is also why the deny probes report "allowed": the statement is genuinely permitted, globally.

---

## 3. Timeline note

The connection-verification audit earlier today recorded `aivideo_web` with `GRANT SELECT ON aivideo.*` and nothing global. The global `ON *.*` grant therefore appeared between that audit and the latest verifier run. Whoever provisioned the account most likely copied the admin pattern visible on this server (`'mysql'@'localhost'` and `'reksa'@'%'` both hold `ALL PRIVILEGES ON *.*`). No application code, env file, or migration issues a GRANT — this is purely server-side drift and cannot be reproduced from the repository.

---

## 4. Impact

| Capability the account actually has | Consequence |
| --- | --- |
| `SELECT` on `*.*` | Reads **16 other application databases**; `SELECT COUNT(*) FROM mysql.user` returned 7, i.e. every account row including password hashes |
| `INSERT` on `*.*` | Can write into any application's tables |
| `UPDATE`, `DELETE` on `*.*` | Can alter or destroy any row in any database on the server |
| `CREATE` on `*.*` | Can create databases/tables outside this project |
| `WITH GRANT OPTION` | Can re-grant these privileges to any other account — privilege escalation beyond this project |

Proof of real cross-schema access (no application data was read — `LIMIT 0` and `COUNT` only):

```
SELECT * FROM `ecommerce_iot`.`products` LIMIT 0   → executed without error (0 rows returned)
SELECT COUNT(*) FROM mysql.user                     → 7
SELECT COUNT(*) FROM mysql.db                       → 5
```

The failure is contained to this server and this account, but it is a genuine cross-project exposure, not a verification artifact.

---

## 5. Isolation check — is the verifier wrong?

### 5.1 What the verifier does

`src/lib/db-access-verify.ts`:

```ts
const schemaRows = await client.query("SELECT schema_name AS name FROM information_schema.schemata");
const unexpected = visible.filter((name) => !ALLOWED_SCHEMAS.includes(name));
```

It treats any schema name beyond `aivideo`/`information_schema` as "access to an unrelated database".

### 5.2 Is `information_schema.SCHEMATA` privilege-filtered here?

Measured on this server, same statement, two accounts:

| Account | Effective grants | `SHOW DATABASES` | `COUNT(*) I_S.SCHEMATA` |
| --- | --- | --- | --- |
| `aivideo_migrator` | `ALL` on `aivideo`, `aivideo_shadow` only | 3 (`aivideo`, `aivideo_shadow`, `information_schema`) | **3** |
| `aivideo_web` | global `SELECT, INSERT, UPDATE, DELETE, CREATE` | 18 | **18** |

So on MariaDB 11.8 this view **is** filtered by privilege. The verifier's 18-schema result is not a false positive: the account really is entitled to see — and to read — all 18 schemas (confirmed independently in §4).

### 5.3 Names vs. access — the general rule

Schema-name visibility and data access are different capabilities and they can diverge:

- **Names only:** an account holding a metadata-only global privilege (`SHOW DATABASES`, `PROCESS`, `CONNECTION ADMIN`) can enumerate schema names while every `SELECT` against those schemas still fails with 1142. The name list would then over-report access.
- **Access without names:** in the other direction, a table-level grant lets you query `db.tbl` directly even if you never see `db` in a filtered list — so a name list can also under-report.

The verifier's binary (`name visible ⇒ FAIL`) is therefore only *incidentally* correct here, where the same global grant causes both symptoms. It cannot distinguish "sees the name" from "can read the data".

### 5.4 Verdict

**The verifier's isolation FAIL is correct for this account and must not be dismissed.** The recommendation is still to harden the check so the two cases cannot be confused:

1. Assert on **privilege attribution** first: no non-`USAGE` row in `information_schema.USER_PRIVILEGES` for the current user, and no `SCHEMA_PRIVILEGES` outside `aivideo`.
2. Then assert on **actual access**: for each schema in `I_S.SCHEMATA` outside the allow-list, `SELECT 1 FROM \`<schema>\`.\`<first table>\` LIMIT 0` must fail with 1142/1144; and `SELECT * FROM \`mysql\`.\`user\` LIMIT 0` must fail.
3. Keep the name list as a *warning*, not a hard failure, once (1) and (2) pass.

Per instruction 7, **no code was changed** — this is a recommendation for a follow-up task.

---

## 6. Recommended SQL (NOT executed)

Run as an administrator (`root@localhost` or an account with `GRANT OPTION`) against `localhost`. MariaDB has no `REVOKE ... IF EXISTS`; the statements below are the minimum that remove the root cause and keep the app working.

```sql
-- 1. Root cause: drop the accidental global grant (UPDATE/DELETE/CREATE and
--    cross-schema SELECT/INSERT all come from this single line).
REVOKE SELECT, INSERT, UPDATE, DELETE, CREATE ON *.* FROM 'aivideo_web'@'localhost';

-- 2. Make sure no residual grant option survives on *.*. After step 1 this is
--    normally already gone; running it is harmless and explicit.
REVOKE GRANT OPTION ON *.* FROM 'aivideo_web'@'localhost';

-- 3. Keep exactly what Phase 1 needs (already present, idempotent).
GRANT SELECT, INSERT ON `aivideo`.`projects` TO 'aivideo_web'@'localhost';
GRANT SELECT, INSERT ON `aivideo`.`assets`   TO 'aivideo_web'@'localhost';
```

Notes:

- Step 1 leaves the account alive with `USAGE`; table-level grants in step 3 (or the existing ones) provide the app's access. Do **not** use `DROP USER` — the password is already configured in `.env.local`.
- No `FLUSH PRIVILEGES` is needed for `GRANT`/`REVOKE` (only for direct `mysql.*` table edits).
- If step 2 returns `ERROR 1141 There is no such grant defined`, it is already satisfied.
- `aivideo_shadow` is intentionally **not** granted to `aivideo_web`; only the migrator needs it.
- Because `mysql.user` was readable for an unknown period, treat the credentials on this server as potentially exposed and rotate the `aivideo_web` password (and review other accounts' passwords) during the same maintenance window. Not done here — changing credentials is out of scope for this audit.

---

## 7. Verification order after the fix (read-only first)

1. `SHOW GRANTS FOR 'aivideo_web'@'localhost';` → expect exactly three lines: `GRANT USAGE ON *.*`, the `projects` grant, the `assets` grant. No `ON *.*` privileges, no `WITH GRANT OPTION`.
2. `SELECT PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = "'aivideo_web'@'localhost'";` → one row: `USAGE / NO`.
3. `SELECT * FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = "'aivideo_web'@'localhost'";` → empty.
4. As `aivideo_web`: `SHOW DATABASES;` → only `aivideo`, `information_schema`.
5. As `aivideo_web`, prove the denial (read-only, `LIMIT 0`):
   `SELECT * FROM \`mysql\`.\`user\` LIMIT 0;` → 1142,
   `SELECT * FROM \`ecommerce_iot\`.\`products\` LIMIT 0;` → 1142.
6. As `aivideo_web`: `SELECT COUNT(*) FROM aivideo.projects;` → still works.
7. Only then (with your approval): `npm run verify:db-access` → expect `identity`, `isolation`, `select:projects`, `select:assets`, `insert:*`, `cleanup` and all four `deny:*` to PASS, with the deny details showing `UPDATE`/`DELETE command denied …`.

Do not skip step 5 — it is the only check that distinguishes "no privilege" from "name still visible".

---

## 8. Limitations of this audit

1. **No live UPDATE/DELETE denial was produced.** The account currently *is* allowed, and nothing was written. Attribution comes from `mysql.user` / `information_schema.USER_PRIVILEGES` / `mysql.tables_priv`, which is authoritative.
2. **Global CREATE was not exercised.** Creating a database would be destructive; `Create_priv=Y` in `mysql.user` is the evidence.
3. **`aivideo_media` was not measured** for the `I_S.SCHEMATA` filtering comparison (its DSN lives in `media-service/.env`, not in the root env files loaded here). The migrator measurement already proves the view is privilege-filtered (3 vs 18).
4. **`mysql.global_priv` was not read.** On MariaDB 11.8 it is the physical store, but `SHOW GRANTS` and the four `information_schema` privilege views are complete for this account; `mysql.global_grants` does not exist here (1146).
5. **No code, schema, grant or credential was modified** as part of this audit, per instructions.

---

## 9. GO / NO-GO

| Item | Decision |
| --- | --- |
| Diagnosis | **Confirmed** — one global `GRANT … ON *.*` with `WITH GRANT OPTION` is the sole cause of both findings |
| Applying the SQL in §6 | **NO-GO from this task** — recommended and ready, but must be run by an administrator in a maintenance window |
| Running `npm run verify:db-access` | **NO-GO now** — it would keep reporting "UPDATE/DELETE allowed" until the grant is removed |
| Hardening the isolation verifier (§5.4) | **Recommended follow-up** — no code changed here |
| Phase 1 sign-off | **BLOCKED** until the grant is revoked and §7 passes |
| Phase 2 | **Not started.** |
