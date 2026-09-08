# SECURITY.md — Threat Model & Audit Results

## Why this file exists (read this first)

**Model-agnostic and tool-agnostic**, like `discuss.md`, `flow.md` and `mainnet.md`. Point
any AI tool or engineer at it and they can see where the money can leak and what has already
been tested.

This platform is **custodial**: it holds user credits and vendor revenue and signs payments
on their behalf. That makes it a target. This file records where funds can be lost, what was
attacked, what broke, and what is still open.

**Rule for whoever edits next:** when you change anything touching money, keys or auth, run
the probes in §3 again and update §4.

---

## 1. What an attacker wants

| Target                  | Where it lives              | Blast radius                                      |
| ----------------------- | --------------------------- | ------------------------------------------------- |
| Custody account key     | `CUSTODY_MNEMONIC` (env)    | Every user's unspent credit                       |
| Settlement account key  | `SETTLEMENT_MNEMONIC` (env) | All vendor revenue held                           |
| Operations account key  | `TREASURY_MNEMONIC` (env)   | The ALGO float                                    |
| `MASTER_ENCRYPTION_KEY` | env                         | Decrypts every stored custodial key               |
| Free API calls          | credit ledger               | Cost per call, unbounded if a race exists         |
| Minted credit           | recharge + onramp webhook   | Unbounded — buys real API calls with fake balance |
| Someone else's session  | `sessions` table            | That user's whole balance                         |
| Vendor payout redirect  | `wallets.address`           | That vendor's entire pending revenue              |

---

## 2. Controls in place

**Keys.** Never leave the server. Custodial keys are AES-256-GCM encrypted at rest
(`services/vault.ts`); treasury mnemonics live only in env and are read once at boot. No
endpoint returns key material — verified in §3.

**Sessions.** Opaque 32-byte random tokens, stored only as SHA-256 hashes, revocable, in
httpOnly cookies. A database leak yields no usable token.

**Sign-in tokens.** Magic links and OTP codes are hashed, single-use, expiring,
attempt-limited (`OTP_MAX_ATTEMPTS`) and rate limited per email. Codes use
`crypto.randomInt` to avoid modulo bias. Comparison is constant-time.

**Payments.** Requirements are always rebuilt server-side — a client-supplied copy is never
trusted, so a caller cannot claim a $50 tier having signed $1. Replay is blocked by a unique
`payment_hash` fingerprint before any on-chain work, and again by the chain itself.

**Credits.** Balance is derived from an append-only ledger, never a mutable column. Debits
are atomic and refuse to go negative. Every credit carries a unique `reference`, so the same
payment or webhook delivery cannot be applied twice.

**Money separation.** Three accounts (operations / custody / settlement) so user float,
earned revenue and running costs cannot be spent on each other. Solvency for both
liabilities is checked at boot and exposed on `/admin/status`.

**Upstream isolation.** The proxy strips `authorization`, `cookie`, `x-api-key` and all
payment headers before calling a publisher's server.

---

## 3. Adversarial testing performed

Run as (a) an outsider with no credentials and (b) a signed-in user trying to cheat.
**35 probes, 33 blocked, 2 real findings** — both fixed and re-tested.

### Blocked

| Category          | Probes                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth              | credits / consume / withdraw / activate / dashboard / settle all reject anonymous callers; forged session cookie and forged bearer token both resolve to no user |
| Webhook forgery   | onramp webhook rejects missing and wrong signatures (would otherwise mint credit)                                                                                |
| Credit abuse      | claiming a tier without payment, negative amount, over-max amount, unknown tier, garbage payload, spending with zero balance                                     |
| Payment tampering | wrong network, group larger than 16, `paymentIndex` out of bounds, negative index, legacy v1 payload, unknown scheme, empty group, non-string group entries      |
| Injection         | SQL injection in slug and email (parameterised statements throughout)                                                                                            |
| Brute force       | wrong OTP rejected, non-numeric OTP rejected, attempts capped                                                                                                    |
| Secret leakage    | `/auth/me`, `/credits`, the 402 challenge and `/health` contain no mnemonic, key or seed                                                                         |

### Finding 1 — Concurrent spend drained the custody account (CRITICAL, fixed)

The balance was checked _before_ payment and debited _after_. Concurrent requests all passed
the check, all settled on chain, and only one debit landed.

**Proven:** a user with credit for exactly one call (0.01 USDC) fired three concurrent
requests. All three succeeded, three payments settled, custody paid **0.03** while the
ledger deducted **0.01**. At scale, $5 of credit could drain the whole custody account.

**Fix:** the credit is now **reserved before** anything is spent on chain
(`routes/consume.ts`). The debit is atomic and refuses to go negative, so the ledger is the
gate. A failed payment is refunded via a `REFUND` entry.

**Re-tested:** same attack — one call succeeded, two rejected with `Insufficient credit`,
custody dropped by exactly **0.01**.

### Finding 2 — `/health` exposed treasury topology (MEDIUM, fixed)

The public health endpoint returned all three account addresses plus solvency figures,
mapping the treasury layout and revealing holdings and liabilities to anonymous callers.

**Fix:** `/health` is now minimal (status, network name, asset id, facilitator up/down).
The full view moved to `/admin/status` behind `ADMIN_TOKEN` with a constant-time comparison.

---

### Finding 3 — Publisher upstream credentials were public (CRITICAL, fixed)

`GET /api/apis/:id` returned the full API row to **anonymous** callers, including
`base_url` and `auth_config`.

**Proven:** an unauthenticated request returned
`base_url: https://internal.vendor.example.com/v1` and
`auth_config: {token:SUPER_SECRET_VENDOR_TOKEN_123}`. Anyone could read every
publisher's upstream address and credentials, then call their API directly — bypassing
payment permanently. This is the worst finding so far: it leaks a third party's secrets,
not just ours.

**Fix:** `base_url`, `auth_config` and `auth_type` are withheld from non-owners, and
`auth_config` is now AES-256-GCM encrypted at rest like every other secret we hold.

**Re-tested:** anonymous sees `WITHHELD`; the owner still sees their own values; the raw
database column no longer contains the plaintext token; and a paid call still delivers
`Authorization: Bearer VENDOR_UPSTREAM_TOKEN_XYZ` to the upstream while the consumer's
cookie does not leak.

### Finding 4 — x402-protected upstreams charged the consumer twice (HIGH, fixed)

The gateway settles _before_ proxying. If a publisher registered an endpoint that was itself
x402-protected, the consumer paid us and then received the upstream's 402 — charged, with no
data. The health check made it worse by treating 402 as healthy (`status < 500`).

**Fix:** publishing probes the upstream with the endpoint's real method and refuses if it
demands its own payment; the health check now treats 402 as OFFLINE; and at runtime an
upstream 402 refunds the consumer and suspends the API so it stops charging others.

**Known limit:** publish-time detection is best-effort. An upstream that validates its
request body _before_ its payment middleware answers a probe with 400 rather than 402, so it
can slip through. The runtime guard is the authoritative protection.

## 4. Risks closed since the first audit

| Risk                                           | How it was closed                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Publisher API key in `localStorage`**        | Publishers now authenticate with the same httpOnly session cookie as users (`middleware/auth.ts`). JavaScript cannot read it, so an XSS on the dashboard can no longer steal a long-lived credential. `X-API-Key` remains only for server-to-server clients, where there is no browser to attack. |
| **Payout address change not re-authenticated** | Changing `wallets.address` now requires a code emailed to the publisher. Setting it the first time does not, because there is no revenue to redirect yet. Verified: a redirect attempt returns `confirmationRequired` and leaves the address unchanged; a wrong code is rejected.                 |
| **`POST /publishers` unauthenticated**         | Requires a session, and the publisher email is taken from the verified session rather than the request body — a caller cannot claim someone else's. Also limited to 5 creations per IP per hour.                                                                                                  |
| **No per-user call rate limit**                | `limitPerUser` on `/consume` (120/min), recharge quote (30/min), recharge (20/min), payout change (10/hour), onramp webhook (60/min per IP). Verified: exactly 120 allowed, the rest 429.                                                                                                         |
| **Refund failure only logged**                 | `services/reconciliation.ts` sweeps every 15 minutes for holds older than 10 minutes with no settlement and no refund, and refunds them. Idempotent by reference, so it is safe to run repeatedly.                                                                                                |
| **Legacy `email_wallets` table**               | Dropped automatically at migration once empty. If rows remain it refuses and prints the addresses, because dropping it would destroy the only copy of those keys.                                                                                                                                 |
| **Turso sync failures silent**                 | Failures are counted and logged (rate-limited to one line a minute), and replication health is reported on `/admin/status`.                                                                                                                                                                       |

## 5. Risks still open

| Risk                            | Why it matters                                                                                               | Mitigation                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Rate limiting is in-process** | Resets on restart; separate instances do not share counters                                                  | Move to Redis before running more than one instance                                            |
| **Single-instance SQLite**      | The credit ledger's atomicity depends on one writer. The reservation fix that stopped the drain relies on it | Move to Postgres before horizontal scaling — this is the hard blocker on running two instances |

---

## 6. Operational practices

- **Never** commit `.env`. Both `backend/.env` and `frontend/.env` are gitignored; a secret
  scan of tracked files is clean.
- **Rotate the Turso token** that was committed in an early version — it is in git history.
- Back up `MASTER_ENCRYPTION_KEY` before it protects anything real; changing it orphans
  every encrypted key.
- Watch `custodySolvent` and `solvent` on `/admin/status`. Either going false means users or
  vendors cannot be paid.
- On mainnet, keep only the working float in custody and settlement; sweep the excess to
  cold storage.

---

## 7. Reproducing the audit

The probe scripts live outside the repo (scratch), but every case is listed in §3 and each
is a plain HTTP request. The concurrency test is the one that matters most:

1. Set a user's credit to exactly one call's price.
2. Fire N concurrent `POST /api/consume/:slug` requests.
3. Exactly one must succeed; the rest must return `Insufficient credit`.
4. The custody account's USDC must drop by exactly one call's price.
