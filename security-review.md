# security-review.md — Review Checklist

## Why this file exists

A security review checklist written **for this codebase**, not a generic one. It started from
the OWASP-style "vibecoder review" pattern — find the places AI-assisted code habitually
fails — and adds the checks that matter for a system that **holds other people's money**.

It is **tool-agnostic**: a human or any AI assistant can follow it without the conversation
that produced it.

Most of it is executable:

```bash
scripts/security-review.sh            # human-readable
scripts/security-review.sh --log      # also writes security-log/<timestamp>.md
scripts/security-review.sh --strict   # UNVERIFIED also exits non-zero
```

Checks that need a running server or a funded chain are **not** in the script. They live in
[verify.md](./verify.md), because a script that silently skips them would be worse than one
that never claimed to run them.

---

## The three rules

**1. Never assume. A check that cannot run is not a pass.**

Every result is `PASS`, `FAIL`, or `UNVERIFIED`. There is no fourth state and no silent skip.
If a file is missing, a command errors, or a tool is absent, the result is `UNVERIFIED` — which
reads louder than `PASS` and must be investigated. This is enforced in the runner, not left to
discipline: `expect_empty` treats any exit code above 1 as unverifiable rather than empty.

**2. Retry once, then record.**

Transient conditions — a slow filesystem, a lock, a network blip — should not read as findings.
Every check gets one retry with a one-second pause. If it still cannot run, it is recorded as
`UNVERIFIED` with the exit code. Continuous failures are therefore visible in the log history
rather than being re-run forever.

**3. Test the test.**

A check that cannot fail is worthless. Before trusting this suite, inject a vulnerability and
confirm it is caught:

```bash
printf '\nconst LEAKED = "sk_live_abcdef0123456789abcdef";\n' >> backend/src/services/proxy.ts
printf '\nexport const d = (c: string) => eval(c);\n' >> backend/src/services/proxy.ts
scripts/security-review.sh          # must FAIL S1.1-* and S4.2
git checkout backend/src/services/proxy.ts
```

This is not hypothetical. The first version of `S1.1` **missed** `const LEAKED_KEY = "sk_live_…"`
because the identifier matched none of its name patterns. That gap was found by running exactly
the test above, and is why there are now two independent secret detectors — one by **name**, one
by **shape**.

---

## Check catalogue

### S1 — Secrets

| ID                     | Checks                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `S1.1-hardcoded-name`  | A credential-ish identifier assigned a long literal                                                           |
| `S1.1-hardcoded-shape` | A known provider token prefix (`sk_live_`, `AKIA…`, `ghp_`, `xox…`, `AIza…`), whatever the variable is called |
| `S1.1-mnemonic-shape`  | 25 space-separated lowercase words — an Algorand mnemonic                                                     |
| `S1.2-env-committed`   | No `.env` tracked by git                                                                                      |
| `S1.3-bundle-secrets`  | No secret **values** in `frontend/.next/static`                                                               |
| `S1.4-public-env`      | No server secret exposed through a `NEXT_PUBLIC_` name                                                        |

> **Known false-positive class for S1.3.** Library code in the bundle _mentions_ secret names:
> `algokit-utils` reads `${NAME}_MNEMONIC` from env, and `use-wallet` has a `WalletId.MNEMONIC`
> enum label. Those are names, not values. The check matches an **assignment to a long literal**
> so it does not fire on them. If it ever does fire, read the match before acting.

### S2 — Authentication and authorisation

Session guards on `/consume`, `/credits`, `/publishers`; API-key guard on `/dashboard`.

`S2.5-idor` is the one that matters most: the dashboard must query by
`req.publisher!.id` — the credential — not by the `publisherId` in the URL. Scoping to the URL
parameter is how one publisher reads another's revenue. Defence in depth: the route also has an
explicit ownership middleware, but the query itself must be safe on its own.

### S3 — Payment integrity

The money path. Each of these encodes a decision from `discuss.md`; breaking one is a
regression even if everything else still passes.

| ID                    | Invariant                                              | Why                                                                                                                       |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `S3.1-debit-first`    | Credit is debited **before** any on-chain spend        | Concurrent calls would all pass a balance check and custody would pay for uncharged calls                                 |
| `S3.2-refund`         | A failed call releases the hold                        | Otherwise a crash strands the user's credit                                                                               |
| `S3.3-replay`         | Gateway computes a payment fingerprint                 | One payment must not buy two calls                                                                                        |
| `S3.4-server-reqs`    | Recharge rebuilds requirements server-side             | A client could claim a $50 tier having signed $1                                                                          |
| `S3.5-onramp-closed`  | Webhook fails closed without its secret                | It mints credit from an external caller                                                                                   |
| `S3.6-onramp-hmac`    | Constant-time HMAC comparison                          | Timing oracle on the signature                                                                                            |
| `S3.7-onramp-cap`     | Webhook bounded by `MAX_RECHARGE_USDC`                 | A compromised or buggy onramp should cost one top-up, not the custody float                                               |
| `S3.8-auth-type-gate` | Publish refuses upstream auth the proxy cannot perform | Settlement happens **before** the upstream call, so an unsupported auth type takes the consumer's money and returns a 401 |
| `S3.9-unique-cols`    | `tx_id` **and** `payment_hash` both UNIQUE             | The replay guard is the database constraint, not application logic                                                        |

### S4 — Injection and execution

No request-derived SQL interpolation, no `eval`/`Function`/`child_process`, no
`dangerouslySetInnerHTML`.

> **Two SQL interpolations are expected and excluded**: `migrations.ts` (`PRAGMA table_info`)
> and `connection.ts` (Turso sync). Both take table names from **code constants**, never from a
> request. If a third appears, look at it — do not widen the exclusion.

### S5 — Data exposure

`vault.ts` is the only module that encrypts or decrypts. No signing key may reach an HTTP
response. `proxy.ts` strips `authorization`/`cookie`/`x-api-key` before calling a publisher's
upstream — otherwise a consumer's credentials leak to a third party. `/admin/status` is behind
`ADMIN_TOKEN`.

### S6 — Error handling

| ID                  | Checks                       | Why                                                                                      |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `S6.1-catch-any`    | No `catch (e: any)`          | It disables every type check inside the handler — exactly where correctness matters most |
| `S6.2-empty-catch`  | No `catch {}`                | A swallowed failure in a payment path is an invisible loss                               |
| `S6.3-handler-last` | The error handler is mounted |                                                                                          |
| `S6.4-no-leak`      | Handler is production-aware  | Stack traces and internal messages must not reach the caller                             |

Use `errorMessage()` / `errorField()` (`backend/src/services/errors.ts`) and
`errorMessage()` / `apiErrorMessage()` (`frontend/src/lib/errors.ts`) to read a thrown value
safely. Comment lines are excluded from `S6.1` — those helpers document the pattern they exist
to replace.

### S7 — Rate limiting

`/consume`, `/credits`, `/auth`, `/publishers`. The gateway itself is economically
self-limiting: every call costs the caller USDC.

### S8 — Dependencies

`npm audit --omit=dev`. **Any critical or high is a FAIL.** Moderate and low pass but are
printed.

> A vulnerability's presence is not proof of reachability, and reachability is not an excuse to
> ignore it. Record which one you established. Worked example: `node-cron` pulled a vulnerable
> `uuid`, but the CVE requires `v3/v5/v6` with a `buf` argument and `node-cron` only calls
> `v4()` — unreachable. It was still removed, because it turned out never to be imported at all.

### S9 — Frontend correctness that fails silently

Not classic security, but the same failure mode: **wrong and invisible**.

| ID                     | Checks                                                      | Why it earned a permanent check                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S9.1-dead-classes`    | No Tailwind arbitrary value containing a space              | The browser splits `class` on whitespace, so `bg-[rgba(255, 255, 255,0.1)]` becomes garbage tokens and generates **no CSS**. 31 of these shipped and rendered nothing for weeks                                                   |
| `S9.2-var-escape`      | No raw `[var(--color-*)]`                                   | The `@theme` block generates real utilities; the escape hatch means someone bypassed the design system                                                                                                                            |
| `S9.3-render-impurity` | No `Math.random()`/`Date.now()` in a render path            | Different value on server and client — hydration mismatch. `Input.tsx` did this for its element `id` and broke `label htmlFor`                                                                                                    |
| `S9.4-raw-palette`     | No raw Tailwind palette colours; state uses semantic tokens | Fixed hex from Tailwind's default scale renders fine but does not follow the light/dark switch — in light mode it is identical to dark. 36 usages were migrated to `success`/`warning`/`error`/`info` before this check was added |

---

## What this suite does NOT cover

Stated explicitly, because an unstated gap reads as a guarantee.

- **Runtime authorisation.** Guards are checked by presence, not by exercising them. A guard
  present but wired incorrectly passes. Gate 6 of [verify.md](./verify.md) tests the live
  session path.
- **The paid call.** Settlement, revenue split and the replay guard are verified by _code shape_
  here. Executing one costs real USDC on chain — see verify.md.
- **Business logic.** Nothing checks that the fee percentage is right or that a tier maps to the
  amount charged.
- **Cryptography.** AES-GCM usage in `vault.ts` is not audited here.
- **The platform itself.** Compromise of GitHub, Railway or npm is out of scope by design — this
  reviews **the code**.
- **Frontend dependencies at runtime.** `npm audit` covers manifests, not what a CDN serves.

---

## Logs

`--log` writes `security-log/<ISO-timestamp>.md` with the commit, branch, per-check results and
an explicit warning when anything is `UNVERIFIED`. The directory is committed on purpose — the
history is the point. Compare runs to see when a check started failing and against which commit.

CI writes one on every pipeline run and uploads it as an artifact.

## When to run

- Before any release or mainnet change
- After a dependency bump or framework upgrade
- After touching anything under `routes/`, `services/`, `middleware/`
- On every CI run (automatic)
- Periodically on `main`, even with no changes — advisories are published against code that has
  not moved
