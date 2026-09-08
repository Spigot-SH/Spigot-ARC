# flow.md — Execution Map

## Why this file exists (read this first)

**This document is written to be model-agnostic and tool-agnostic.** It does not assume
Claude, Cursor, Copilot, Codex, or any particular assistant. If you switch AI tools — or
onboard a new engineer — point them at this file plus `discuss.md` and they can navigate
the codebase without reading every file or replaying any chat history.

`flow.md` answers **what calls what, and in what order**. `discuss.md` answers **why**.
Keep them in sync: if you change an entry point, a request path, or the order of
operations in a payment, update this file in the same change.

Every reference below is `path:function` so it can be jumped to directly.

### Environment files (fill these in, they are gitignored)

| Path           | Purpose                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/.env` | Copy from `backend/.env.example`. All server secrets. Read exactly once, at boot, by `backend/src/config.ts` via `dotenv/config` imported at the top of `backend/src/index.ts`. |

Nothing outside `config.ts` reads `process.env` in the backend. **If you need a new setting,
add it to `config.ts` and to `.env.example` — do not read `process.env` elsewhere and do not
hardcode.**

---

## 1. Entry points

| Entry point            | Used when                                           | What it does                                                    |
| ---------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| `backend/src/index.ts` | Local dev (`npm run dev`) and any long-running host | Builds the Express app and calls `app.listen()`                 |
| `cli/bin/spigot.mjs`   | CLI (`npx spigot.sh`)                               | Terminal CLI for publishers to register, price, and settle APIs |

`npm run dev` at the repo root starts the backend service on port **4402**.
The web frontend is housed in a separate standalone repository/directory (`spigot-website`),
which proxies API calls to this backend origin.

---

## 2. Backend boot order

`backend/src/index.ts`, top to bottom — order matters:

```
import 'dotenv/config'          → environment loaded before anything reads config
config.ts evaluated             → validates secrets; in dev generates and caches
                                  SESSION_SECRET / MASTER_ENCRYPTION_KEY under data/
cors()                          → exposes PAYMENT-REQUIRED, PAYMENT-RESPONSE, NANOPAYMENT-* headers
cookieParser()                  → required before withSession can read the cookie
body parser (conditional)       → express.raw() for /nanopay/*, /pay/*, /x402/* (proxied verbatim, must stay bytes)
                                  express.json() for everything else
withSession                     → attaches req.user when a session cookie (spigot_session or x402_session) or Bearer token is valid
runMigrations()                 → creates tables, adds missing columns, creates indexes
route mounting                  → see the table below
errorHandler                    → last, so it catches everything above
app.listen() + reportReadiness()→ warns if the facilitator is unreachable or the treasury is unset
```

`reportReadiness()` is advisory only — it never blocks startup.

### Route mounting

Every route is mounted twice, bare and `/api`-prefixed, so the Next rewrite and any direct
server-to-server caller can both reach it.

| Mount                       | Router                   | Auth                                                                                                                                |
| --------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/health`                   | inline in `index.ts`     | none                                                                                                                                |
| `/auth`                     | `routes/auth.ts`         | none, except `/wallet/provision`                                                                                                    |
| `/consume`                  | `routes/consume.ts`      | **session** (`requireSession`)                                                                                                      |
| `/publishers`               | `routes/publishers.ts`   | API key, except `POST /` which needs a **session** (`requireSession`) — unauthenticated creation let anyone mint publisher accounts |
| `/verify`                   | `routes/verification.ts` | API key                                                                                                                             |
| `/apis`                     | `routes/apis.ts`         | API key, except `GET /` and `GET /:id`                                                                                              |
| `/apis/:id/pricing`         | `routes/pricing.ts`      | API key                                                                                                                             |
| `/apis/:id/test`            | `routes/testing.ts`      | API key                                                                                                                             |
| `/dashboard/:publisherId`   | `routes/dashboard.ts`    | API key + ownership guard                                                                                                           |
| `/nanopay`, `/pay`, `/x402` | `routes/gateway.ts`      | **payment**                                                                                                                         |

**Two independent auth systems exist by design:** publishers use an `X-API-Key`
(`middleware/auth.ts:authenticate`), consumers use session cookies
(`middleware/session.ts:requireSession`). They are not linked.

---

## 3. Flow: sign in (any of three methods)

All three converge on the same user and wallet.

```
SignInModal.tsx
  ├── Google:     window.google.accounts.id → authApi.signInWithGoogle(credential)
  │                 → POST /api/auth/google
  ├── Magic link: authApi.requestMagicLink(email) → POST /api/auth/magic-link
  │                 → user clicks link → GET /api/auth/magic-link/callback
  └── OTP:        authApi.requestOtp(email)    → POST /api/auth/otp
                    → authApi.verifyOtp(email, code) → POST /api/auth/otp/verify
```

### Server side (`routes/auth.ts`)

```
POST /auth/magic-link  or  /auth/otp
  rateLimit(key, max, windowMs)          in-memory, per email
  crypto.randomBytes / crypto.randomInt  token or 6-digit code
  issueToken()                           invalidates prior live token, stores SHA-256 hash
    └── services/vault.ts:hashToken
  services/mailer.ts:sendEmail
    └── Resend if RESEND_API_KEY, else prints to console

GET /auth/magic-link/callback   |   POST /auth/otp/verify
  consumeToken()                 single-use, expiry- and attempt-checked
    └── vault.ts:safeEqual       constant-time compare
  services/users.ts:upsertUser
    ├── finds or creates the users row, appends the provider
    └── ensureWallet(userId)
         ├── services/wallet.ts:createCustodialWallet (Algorand)
         │     algosdk.generateAccount → vault.ts:encryptSecret → custodial_wallets (chain='algorand')
         ├── services/wallet.ts:createCustodialEvmWallet (EVM)
         │     viem.generatePrivateKey → vault.ts:encryptSecret → custodial_wallets (chain='evm')
         └── services/treasury.ts:provisionWallet (Algorand)   ← BACKGROUND, not awaited
  startSession → services/session.ts:createSession → setSessionCookie
```

### Wallet provisioning (`services/treasury.ts:provisionWallet`)

Idempotent; each step is skipped when already satisfied. **Order is mandatory** — an
Algorand account cannot receive an ASA before opting in.

```
1. getBalances(address)
2. if algo < WALLET_FUNDING_MICROALGOS  → fundWithAlgo()    treasury pays 0.201 ALGO
3. if not optedIn                       → wallet.ts:optInToUsdc()   signed by the user's own key
4. if usdc == 0 and SIGNUP_USDC_GRANT>0 → sendUsdc()        treasury grants starter USDC
5. mark custodial_wallets.funded_at
```

The frontend (`auth/AuthContext.tsx`) polls `/auth/me` every 4s for up to 60s while
`balances.optedIn` is false, so the UI unlocks on its own when provisioning finishes.

---

## 4. Flow: paid API call, no wallet popup (the core path)

This is what makes the product walletless. Two HTTP hops: browser → `/consume`, then
backend → its own `/nanopay` (or `/x402`) gateway carrying the payment.

```
ConsumerTest.tsx:handleCall
  └── authApi.consume(apiSlug, {endpointId, chain})
       → POST /api/consume/:apiSlug            [requireSession]

routes/consume.ts
  1. look up api, endpoint, pricing
  2. credits.ts:debit  ← RESERVE FIRST, before anything is spent on chain
       ├── atomic, refuses to go negative — the ledger is the gate, not a balance check
       ├── InsufficientCredit → 402 {error:'Insufficient credit', topUpRequired:true}  [STOP]
       └── holds under `hold:<uuid>`; releaseHold() refunds on any failure below
  3. nanopaymentProtocol.ts:buildPaymentRequirements (or buildPaymentRequirementsList)
       └── facilitator.ts:getFeePayer   ← cached 5 min from GET /supported (Algorand only)
       └── treasury.ts:getPlatformAddress / config.ARC_SETTLEMENT_ADDRESS
  4. Payment construction (routed by chain family in services/payment.ts — zero @x402 dependencies):
       ├── Arc Testnet (Circle Arc L1 — Primary):
       │     createEvmPaymentForWallet(userWallet, reqs) or createPaymentFromCustody(reqs)
       │     signs EIP-3009 TransferWithAuthorization using EIP-712 typed data;
       │     records nanopayments in DB and settles via Arc JSON-RPC using native USDC gas
       ├── EVM (Ethereum, Base, Arbitrum, Optimism, Avalanche, Robinhood):
       │     createEvmPaymentForWallet(userWallet, reqs) signs via native viem EIP-712 typed data
       │     using EIP-3009 transferWithAuthorization
       ├── Solana: createSolanaPaymentForWallet(userWallet, reqs) signs via native @solana/web3.js
       │     with feePayer sponsorship
       ├── Stellar: createStellarPaymentForWallet(userWallet, reqs) signs via native Stellar SDK
       │     with Soroban authorization entries and sponsored fees
       └── Algorand: createPaymentForWallet(userWallet, reqs) or createPaymentFromCustody(reqs)
             signs via native algosdk
  5. encodePaymentHeader → base64
  6. fetch(GATEWAY_BASE_URL/nanopay/:slug:path, {headers: {NANOPAYMENT-SIGNATURE, PAYMENT-SIGNATURE}})
  7. gateway routes verification/settlement by network prefix:
       ├── eip155:5042002 (Arc Testnet) → nanopayments.ts verify/record/settle & Arc RPC
       ├── eip155:*   → EVM facilitator (EVM_FACILITATOR_URL)
       ├── solana:*   → Solana facilitator (SOLANA_FACILITATOR_URL) / direct broadcast
       ├── stellar:*  → Stellar facilitator (STELLAR_FACILITATOR_URL) / direct broadcast
       └── algorand:* → GoPlausible facilitator (with direct broadcast / microALGO fallback)
  8. decode the NANOPAYMENT-RESPONSE / PAYMENT-RESPONSE header → return {response, payment:{txId, explorerUrl, network}}
```

**Why a credit ledger instead of checking the wallet balance:** concurrent requests would all
pass a balance check, all settle on chain, and only one debit would land — custody would pay
for calls nobody was charged for. Debiting first makes the ledger authoritative. Users hold a
credit balance rather than per-user Algorand accounts, so one opted-in custody account
replaces one account per user.

### The gateway itself (`routes/gateway.ts`, `router.all('/:apiSlug/{*path}')`)

Reachable directly via `/nanopay`, `/pay`, or `/x402` by any client — `/consume` is a convenience wrapper,
not the only way in.

```
 1. resolve api by slug (must be PUBLISHED) → endpoint by method+path → pricing
 2. nanopaymentProtocol.ts:buildPaymentRequirements
 3. no NANOPAYMENT-SIGNATURE / PAYMENT-SIGNATURE / X-PAYMENT header?
      → nanopaymentProtocol.ts:buildChallenge + encodeHeader
      → 402 with NANOPAYMENT-REQUIRED and PAYMENT-REQUIRED headers and JSON in body   [STOP]
 4. nanopaymentProtocol.ts:decodePaymentPayload   validates version, scheme, payload
 5. network must match requirements
 6. nanopaymentProtocol.ts:paymentFingerprint → SELECT transactions WHERE payment_hash
      → already present? 402 "already used"                                  [STOP]
 7. facilitator.ts:verifyPayment   POST /verify   facilitator simulates on-chain
      → isValid false? 402 with invalidReason                                [STOP]
 8. facilitator.ts:settlePayment   POST /settle   facilitator signs fee txn, submits group
      → success false? 402 with errorReason                                  [STOP]
 9. INSERT transactions (tx_id + payment_hash, both unique)  ← replay guard commits here
10. set NANOPAYMENT-RESPONSE and PAYMENT-RESPONSE headers
11. services/proxy.ts:proxyRequest   upstream call
12. INSERT usage (revenue split by PLATFORM_FEE_PERCENT)
```

**Settlement happens at step 8, before the upstream call at step 11** — deliberate, see
`discuss.md` Decision 8.

### `services/proxy.ts:proxyRequest`

Builds the target URL, filters headers through `BLOCKED_HEADERS` (drops `authorization`,
`cookie`, `x-api-key`, all payment headers and hop-by-hop headers), injects the publisher's
configured upstream auth (`API_KEY` / `BEARER` / `BASIC`), forwards the **raw body bytes**,
and returns `{statusCode, latency, responseSize}` for the usage row.

---

## 5. Flow: publisher onboarding

Unchanged from the original design; API-key authenticated throughout.

```
Onboarding.tsx (wizard steps in components/steps/)
  POST /publishers                  → publishers.ts   returns {id, api_key} → localStorage
  POST /verify/initiate             → verification.ts returns a TXT record to publish
  POST /verify/check                → resolves DNS TXT, or bypasses when
                                      DOMAIN_VERIFY_BYPASS=true and not production
  POST /apis                        → apis.ts
  POST /apis/:id/endpoints          → manual, or /apis/:id/import for an OpenAPI spec
  POST /apis/:id/pricing            → pricing.ts
  POST /publishers/:id/wallet       → payout address (plain text field, no wallet connect)
  PUT  /apis/:id/publish            → requires endpoints + pricing + wallet; sets PUBLISHED
```

Revenue reaches the publisher via `services/settlement.ts:processSettlement` →
`treasury.ts:sendUsdc`. It is **not currently wired to any route or scheduler** — call it
manually or add a cron.

---

## 6. Module layers

Arrows point downward only; there are no cycles.

```
routes/       auth  consume  gateway  apis  pricing  publishers  dashboard  testing  verification
                │       │       │        └──────── middleware/auth ────────┘
                │       │       │
middleware/   session ──┴───────┘
                │
services/     users ─→ session ─→ vault
              users ─→ wallet  ─→ vault
              users ─→ treasury ─→ wallet
              consume/gateway ─→ x402 ─→ facilitator
                                  x402 ─→ treasury
              gateway ─→ payment ─→ facilitator, wallet
              gateway ─→ proxy
              settlement ─→ treasury
                │
db/           connection ─→ schema, migrations
                │
config.ts     (leaf — the only reader of process.env)
```

**Key rule:** `services/vault.ts` is the only module that encrypts or decrypts. `getSigningKey`
returns a decrypted key **for signing only** and its result must never reach an HTTP response.

---

## 7. Frontend structure

The frontend application, Next.js routes, UI components, and design system have been moved
to a dedicated repository/directory: **`../spigot-website`**.

In that directory:

- Next.js App Router root with `/`, `/onboarding`, `/dashboard`, `/profile`, `/test/[apiSlug]`
- Static design system under `public/designsystem/`
- Design system documentation (`ui.md`, `taste.md`, `geist-notes.md`, `designsystem-plan.md`, `designsystem-gap.md`)
- `next.config.ts` proxies `/api` and `/x402` to this backend origin (`BACKEND_ORIGIN`)

---

## 8. Data model

| Table                                          | Holds                       | Notes                                                           |
| ---------------------------------------------- | --------------------------- | --------------------------------------------------------------- |
| `users`                                        | consumer identity           | one row per email across all three sign-in methods              |
| `sessions`                                     | login sessions              | `token_hash` only; revocable                                    |
| `auth_tokens`                                  | magic links, OTP codes      | hashed, single-use, expiring, attempt-counted                   |
| `custodial_wallets`                            | per-user custodial wallet   | `encrypted_key` is AES-256-GCM; default chain `arc-testnet`     |
| `nanopayments`                                 | EIP-3009 nanopayments       | off-chain signatures, authorization nonces, batch assignments   |
| `nanopayment_batches`                          | on-chain settlement batches | tx hash, aggregate amount, settled status on Arc Testnet        |
| `publishers`                                   | API providers               | `api_key` auth, separate from `users`                           |
| `apis`, `endpoints`, `pricing`, `skills`       | catalogue                   | `apis.status` gates the gateway                                 |
| `transactions`                                 | settled payments            | `tx_id` and `payment_hash` both unique — the replay guard       |
| `usage`                                        | per-call record             | revenue split; also records failed upstreams for reconciliation |
| `wallets`, `settlements`                       | publisher payouts           |                                                                 |
| `health_checks`, `verifications`, `audit_logs` | operational                 |                                                                 |
| `email_wallets`                                | **legacy, unused**          | plaintext mnemonics from the old auth. Drain and drop.          |

`db/migrations.ts:addColumnIfMissing` exists because `CREATE TABLE IF NOT EXISTS` never
alters an existing table — new columns must be added explicitly for already-deployed databases.

---

## 9. External services

| Service                   | Used by                                                | Failure behaviour                                                                       |
| ------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Arc Testnet RPC           | `services/nanopayments.ts`, `treasury.ts`, `wallet.ts` | native USDC gas transfers and nanopayment batch settlements on Arc (Chain ID 5042002)   |
| GoPlausible facilitator   | `services/facilitator.ts`                              | `/supported` cached 5 min; verify/settle failures return 402 or 502, never serve unpaid |
| EVM facilitator           | `services/facilitator.ts`                              | `EVM_FACILITATOR_URL` for `eip155:*` verification and settlement                        |
| Solana facilitator        | `services/facilitator.ts`                              | `SOLANA_FACILITATOR_URL` for `solana:*` verification and settlement                     |
| Stellar facilitator       | `services/facilitator.ts`                              | `STELLAR_FACILITATOR_URL` for `stellar:*` verification and settlement                   |
| Algorand algod (Algonode) | `services/wallet.ts`, `treasury.ts`                    | balance reads and treasury transactions                                                 |
| EVM RPCs                  | `services/payment.ts`                                  | public JSON-RPC nodes for Ethereum, Base, Arbitrum, Optimism, Avalanche, Robinhood      |
| Solana RPC                | `services/payment.ts`, `wallet.ts`                     | public JSON-RPC node for Solana Devnet                                                  |
| Google Identity Services  | `routes/auth.ts`                                       | 503 when `GOOGLE_CLIENT_ID` is unset                                                    |
| Resend                    | `services/mailer.ts`                                   | falls back to console output                                                            |
| Turso                     | `db/connection.ts`                                     | optional replication; disabled when credentials are blank                               |
