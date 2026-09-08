# discuss.md — Decision Record

## Why this file exists (read this first)

**This document is written to be model-agnostic and tool-agnostic.** It is not tied to
Claude, Cursor, Copilot, Codex, or any specific assistant. If you switch to a different AI
tool — or hand this repo to a new engineer — point them at this file plus `flow.md` and
they will have the full picture without needing the original chat history.

It answers the question source code cannot: **why** the code looks like this. Anything that
was a judgement call, a trade-off, or a rejected alternative is recorded here with its
reason, so a future reader does not "fix" a deliberate decision or repeat a dead end.

**Rules for whoever edits this file next (human or AI):**

1. Append new sessions at the bottom. Never rewrite or delete past sessions — a decision
   that was later reversed is still useful history. Mark reversals with `SUPERSEDED BY`.
2. Every decision gets a **reason**. "We chose X" is useless; "We chose X because Y, and
   rejected Z because W" is the point of the file.
3. Record what actually changed in the session (files, behaviour), not what was planned.
4. If you discover a decision here is wrong, add a new entry — do not silently edit an old one.

### Environment files (fill these in, they are gitignored)

| Path                  | Purpose                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/.env`        | Copy from `backend/.env.example`. Holds all server secrets: treasury mnemonic, encryption key, session secret, Google client ID, Resend key, Turso credentials.                                                                     |
| `frontend/.env.local` | Copy from `frontend/.env.example`. `NEXT_PUBLIC_`-prefixed values ship to the browser — never put a secret in one. `BACKEND_ORIGIN` is the exception: it is read only by `next.config.ts` in the Node process and is never inlined. |

Both are matched by `.gitignore` (`.env` and `*.env`). The server refuses to boot in
production if a required secret is missing; in development it generates and caches
throwaway secrets under `backend/data/` so a fresh clone runs with no setup.

---

## Session 1 — 2026-08-14 — Analyse and run the existing codebase

**Goal:** understand the repo and get it running locally.

### What was done

- Installed workspace dependencies (none were present), created `backend/.env` from the example, started both servers.
- Ran the publish → 402 → payment flow end to end against the then-current code.
- Confirmed the monorepo layout: `backend/` (Express 5 gateway), `frontend/` (React 19 + Vite), `api/index.ts` (Vercel serverless wrapper).

### State found

Working: 402 challenge generation, on-chain verification rejecting a forged tx, publisher
onboarding, marketplace listing, proxying for GET requests.

### Problems identified (all addressed in Session 2)

| Problem                                                                                    | Why it mattered                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /auth/email-wallet` returned any wallet's **plaintext mnemonic** keyed only by email | Anyone who guessed an email got full custody of that wallet. Mnemonics were also stored unencrypted.                                                                     |
| Turso URL + auth token hardcoded in `config.ts`                                            | Live credentials committed to git. The token was already returning 401, and every sync error was silently swallowed, so the app ran against an empty DB with no warning. |
| `proxy.ts` called `JSON.stringify(req.body)` on a Buffer                                   | Gateway routes use `express.raw()`, so every non-GET proxy sent `{"type":"Buffer","data":[…]}` upstream. Only GET worked.                                                |
| Proxy forwarded all client headers upstream                                                | The consumer's `authorization` and `cookie` headers leaked to third-party publisher servers.                                                                             |
| `verifyPayment()` ignored its own `expectedAmount` / `expectedReceiver` arguments          | Misleading; the real check happened elsewhere, so not exploitable, but the function name lied.                                                                           |

---

## Session 2 — 2026-08-14 — GoPlausible facilitator, custodial wallets, new auth

**Goal, in the user's words:** testnet; the facilitator pays the ALGO; no wallet popup;
the backend handles everything; _"user should not care about wallet"_. Plus magic-link and
OTP sign-in alongside Google.

### Decision 1 — Adopt the GoPlausible x402 facilitator

**Chosen:** route verification and settlement through `https://facilitator.goplausible.xyz`.

**Reason:** it is the reference Algorand x402 implementation (built with the Algorand
Foundation, merged into Coinbase's x402 spec as `scheme_exact_algo.md`), and critically it
implements **fee abstraction** — the payment group's first transaction is an unsigned
`pay` from the facilitator's fee payer, which it signs and pays for. This is precisely the
"facilitator pays ALGO" requirement. `/supported` confirms Algorand testnet is live with
fee payer `ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA`.

**Rejected:** running our own facilitator. It would need its own funded fee-payer account
and ongoing ALGO management — the opposite of the goal.

### Decision 2 — Migrate x402 v1 → v2

**Reason:** the facilitator speaks v2 only. v2 differs structurally, not cosmetically:

- Network IDs are CAIP-2 genesis hashes (`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`), not `algorand:testnet-v1.0`.
- The payload is an **atomic transaction group**, `{paymentGroup: [b64…], paymentIndex}`, not a bare tx id.
- Amounts are atomic units as strings (`"10000"` = 0.01 USDC), not decimals.
- Verification is a facilitator-side on-chain **simulation**, not an indexer lookup after the fact.

### Decision 3 — Switch USDC from `67395862` to `10458941`

**Reason:** `10458941` is the canonical Algorand testnet USDC used throughout the official
docs and obtainable from standard faucets. `67395862` is a non-standard test asset that is
hard to acquire. The facilitator accepts whatever asset the requirements name, so this was
a usability decision, not a compatibility one.

### Decision 4 — Custodial wallets with keys encrypted at rest

**Chosen:** the backend generates an Algorand account per user and stores the 64-byte
secret key AES-256-GCM encrypted under `MASTER_ENCRYPTION_KEY`.

**Reason:** "no wallet popup, user should not care about wallet" requires the server to
hold the key — there is no way to sign without one. The old code did this too but stored
mnemonics in plaintext and served them over HTTP. Encryption at rest plus never returning
the key is the minimum responsible version of the same feature.

**Consequence to be aware of:** this is custody. Rotating `MASTER_ENCRYPTION_KEY` orphans
every existing wallet. Documented in `.env.example`.

**Not deleted:** the legacy `email_wallets` table still exists in the schema but nothing
reads or writes it. Dropping it would destroy data on already-deployed databases. Those
wallets must be treated as compromised and drained, then the table dropped manually.

### Decision 5 — The treasury funds each new wallet with ~0.201 ALGO

**Reason:** the facilitator covers _transaction fees_, but Algorand's **0.1 ALGO minimum
balance requirement** for holding an ASA is protocol-level and cannot be sponsored. Someone
must fund it once per user. The treasury absorbing it keeps the promise that the _user_
never needs ALGO. Chosen over lazy funding (adds seconds to the first payment) and manual
top-up (not self-serve).

Provisioning runs in the background after sign-in so a slow chain never blocks the response,
and is idempotent — each step is skipped when already satisfied.

### Decision 6 — Opaque database-backed sessions, not JWTs

**Chosen:** a random 32-byte token in an httpOnly cookie; only its SHA-256 hash is stored.

**Reason:** sessions must be revocable on sign-out, and a database leak must not yield
usable tokens. A stateless JWT gives neither. `jose` was installed and then **uninstalled**
when this became clear. `Authorization: Bearer <token>` is also accepted so scripts and
agents can use the same sessions as the browser.

### Decision 7 — Three sign-in methods, one user record

Google (ID token verified server-side against Google's public keys via
`google-auth-library` — no OAuth redirect to maintain), magic link, and 6-digit OTP. All
converge on `upsertUser()`, which appends the provider to `auth_providers`, so signing in
with Google and later with a code lands on the same account and the same wallet.

Tokens and codes are stored **hashed**, single-use, expiring, attempt-limited, and rate
limited per email. `crypto.randomInt` is used for codes to avoid the modulo bias of
`Math.random`.

**Email delivery:** Resend when `RESEND_API_KEY` is set, otherwise the link or code is
printed to the server console. **Reason:** the whole flow must be testable on a fresh clone
with zero third-party setup.

### Decision 8 — Settle _before_ proxying upstream

**Reason:** the alternative (serve, then settle) means a settlement failure after a
successful upstream call gives the API away for free. Settling first guarantees the
publisher is paid. **Accepted trade-off:** a consumer can pay for a request whose upstream
then errors; those rows land in `usage` with the upstream status code for refund
reconciliation. Revisit if upstream flakiness becomes the common case.

### Decision 9 — Replay protection by payment fingerprint

A SHA-256 of the signed `paymentGroup` is stored in `transactions.payment_hash` with a
unique index, checked **before** any facilitator call. **Reason:** the settle txid only
exists after settlement, so it cannot guard the work that precedes it. The fingerprint is
known the moment the request arrives.

### Decision 10 — Remove Pera/Defly wallet integration from the payment path

Dropped `@txnlab/use-wallet`, `@txnlab/use-wallet-react`, `@perawallet/connect`, and
`algosdk` from the frontend; deleted `frontend/src/wallet/`. Publisher payout addresses
remain a plain text field. **Result:** the browser bundle went from ~1.4 MB across chunks
to a single 328 kB file.

### Files changed

**Backend — new:** `services/facilitator.ts`, `services/vault.ts`, `services/wallet.ts`,
`services/treasury.ts`, `services/payment.ts`, `services/session.ts`, `services/users.ts`,
`services/mailer.ts`, `middleware/session.ts`, `routes/consume.ts`.

**Backend — rewritten:** `config.ts`, `routes/auth.ts`, `routes/gateway.ts`,
`services/x402.ts`, `db/schema.ts`, `db/migrations.ts`, `index.ts`.

**Backend — deleted:** `routes/faucet.ts`, `services/algorand.ts` (both superseded by
`treasury.ts` / `wallet.ts`).

**Frontend — new:** `api/auth.ts`, `auth/AuthContext.tsx`, `auth/SignInModal.tsx`,
`auth/AccountChip.tsx`. **Rewritten:** `App.tsx`, `pages/ConsumerTest.tsx`,
`pages/Profile.tsx`. **Deleted:** `src/wallet/`.

### Incidental bugs fixed in `services/settlement.ts`

- The 5% platform fee was deducted a **second** time from a figure already net of it
  (`usage.publisher_revenue` is stored net). Publishers were being charged twice.
- `Math.floor(netAmount)` zeroed every payout under 1 USDC.

### Verified

OTP (wrong code rejected, correct code signs in, replay rejected), magic link (single-use,
cookie set, correct redirect), v2 challenge shape with `feePayer` present, and — against
the live facilitator — a payment group of size 2 with `paymentIndex: 1` whose payer matches
the wallet. The facilitator parsed it, signed the fee transaction, simulated on-chain, and
failed only on `asset 10458941 missing from <wallet>`, i.e. the wallet was not yet opted in.
**No format objection**, which is the strongest available proof the integration is correct
short of funded wallets.

---

## Session 3 — 2026-08-14 — Minimalism pass, env samples, pre-existing bug fixes

### Decision 11 — `ponytail` is a review lens, not a dependency

The user pointed at `github.com/dietrichgebert/ponytail` to "build this with". On reading
it, it is **not** a payments or auth library — it is an AI-agent ruleset ("think like the
laziest senior dev"): a decision ladder of YAGNI → reuse → stdlib → native → existing deps
→ one-liner → minimal code, plus _favor deletion over addition_ and _no abstractions nobody
asked for_.

**Chosen:** apply it as a review lens over the code. **Rejected:** installing it as a
project dependency, which would make no sense. Flagged to the user in case they meant to
install it as an agent plugin in their own tooling — that is a separate, environment-level
change.

### Decision 12 — Treasury USDC opt-in

The treasury held 10 ALGO but `assets: []`. The user's 20 USDC transfer had been **rejected
on-chain** because an Algorand account must opt into an ASA before it can receive it.
Nothing was lost. Opted the treasury in (txid
`Z5PTAJNQ5B72FKFOA3XYE3SGRBZEJ34DRF34GH2SGGX5MCFHML4Q`); it now shows `ASA 10458941 = 0`
and can receive.

**Worth remembering:** this same rule is why `provisionWallet()` must opt each user wallet
in _before_ the USDC grant, not after.

### Decision 13 — Domain verification actually implemented; bypass no longer defaults on

`DOMAIN_VERIFY_BYPASS` was `process.env.DOMAIN_VERIFY_BYPASS !== 'false'` — **true unless
explicitly disabled**. A production deploy that never set the variable would let any
publisher claim any domain, including one they do not own. `/verify/check` had no real
implementation at all behind it.

**Fixed:** real DNS TXT proof using node's built-in `dns/promises` (stdlib — ladder rung 3,
no new dependency), and the bypass is now opt-in **and** ignored when
`NODE_ENV=production`.

### Decision 14 — Configuration extracted, duplication removed

| Change                                                   | Reason                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explorer URL → `EXPLORER_BASE_URL`, returned by the API  | It was hardcoded in both `consume.ts` and `Profile.tsx`. Serving it from the backend keeps one source of truth instead of a second frontend env var. |
| `maxTimeoutSeconds: 60` → `PAYMENT_TIMEOUT_SECONDS`      | Protocol knob; should not require a code edit.                                                                                                       |
| `https://api.x402gateway.com` → `window.location.origin` | The gateway is served from the same origin. Correct by default, needs no configuration at all.                                                       |
| `api/auth.ts` importing `BASE_URL` from `client.ts`      | I had duplicated the env-parsing logic — a reuse-ladder violation of my own making.                                                                  |
| `dashboard.ts`: one `router.use` guard                   | The same four-line ownership check appeared in all four handlers. 134 → 121 lines.                                                                   |
| Deleted the `PLATFORM_WALLET_MNEMONIC` fallback          | Back-compat nobody asked for. `TREASURY_MNEMONIC` is the only name.                                                                                  |
| 5xx errors no longer echo `err.message` in production    | It leaked file paths, SQL and upstream detail. 4xx messages still pass through.                                                                      |

### Decision 15 — Environment samples for both workspaces

`backend/.env.example` rewritten with every variable grouped and commented;
`frontend/.env.example` created (the `VITE_` vars were previously undocumented anywhere).

Verified by diffing every `process.env.X` read in the backend against the documented list.
Three gaps found and closed: `DATABASE_PATH` was undocumented, `PLATFORM_WALLET_MNEMONIC`
was deleted rather than documented, and `VERCEL` is platform-injected so is intentionally
absent. A secret scan of tracked files came back clean.

### Verified

Dashboard guard on all four routes (own 200, other publisher 403, no key 401, sub-route
403). Domain hostname normalisation (scheme, path and port stripped; invalid input
rejected) and TXT rejection of an unmatched challenge against a live domain. Backend
typecheck clean; both workspaces build.

### Open at end of session

The end-to-end funded payment. Blocked only on USDC reaching the treasury at
`F6Y3JB7PBRPODQCJJEFCM6373JZGHCZ33PMCBXF5NP5OL42XSB6V5VCFGA` (asset `10458941`).
Everything upstream of "wallet has USDC" is verified.

---

## Session 4 — 2026-08-14 — Treasury opt-in automated; end-to-end payment proven

### Decision 16 — The treasury opts itself into USDC at boot

`services/treasury.ts:ensureTreasuryReady()`, called from `index.ts:reportReadiness()`.

**Reason:** the treasury opt-in had been a manual step performed by hand in Session 3,
which is exactly how the original 20 USDC transfer was lost — an Algorand account silently
rejects an ASA transfer until it has opted in. Anyone swapping `TREASURY_MNEMONIC` for a
fresh account would have hit the same wall with no warning.

Behaviour: skipped when already opted in; opts in automatically when the treasury holds
≥ 0.2 ALGO; otherwise logs a clear instruction naming the address and the shortfall. It is
advisory and never blocks startup, matching the rest of `reportReadiness`.

### End-to-end payment verified on Algorand testnet

Full path exercised with no manual steps: publisher publishes a paid endpoint → consumer
signs in with an emailed code → wallet auto-provisioned (0.2 ALGO → USDC opt-in → 1 USDC
grant) → one call to `POST /api/consume/:slug`.

Settled transaction `ITJAEDLDQOAJUJJGGR7C3GUVYVSDYXNUWQEMZCSB4XYNI5FSDICA`,
confirmed round 66308377, 5.5s end to end.

On-chain confirmation of the central design goal:

| Check                | Result                                                    |
| -------------------- | --------------------------------------------------------- |
| Fee paid by the user | **0 microAlgos** — the facilitator's fee payer covered it |
| User ALGO balance    | 0.2 → 0.2, unchanged by the payment                       |
| User USDC balance    | 1.0 → 0.99, exactly the 0.01 price                        |
| Transaction shape    | `axfer` inside an atomic group, asset `10458941`          |

This closes the last open item from Session 2. The "facilitator pays the ALGO, user never
touches a wallet" architecture is proven, not just assumed.

---

## Session 5 — 2026-08-14 — Deposit-first economics, withdrawals, vendor settlement

### Decision 17 — Vendor funds stay a ledger balance, settled on demand

**Chosen:** payments continue to land in the single treasury address; each publisher's
earnings are tracked in `usage.publisher_revenue` and paid out to _their own external
address_ when they click Settle.

**Rejected — a custodial on-chain wallet per vendor**, which was the original proposal:

- Payments settle to one `payTo`. Per-vendor wallets would need per-vendor `payTo`, so the
  platform fee could no longer be taken inside the same transfer — every API call would
  need a **second on-chain transfer**.
- Every account permanently locks 0.1 ALGO of minimum balance, per vendor.
- It does not reduce custody risk, which was the stated motivation. A vendor wallet whose
  key the platform holds is no safer than a ledger row — the platform is custodian either way.

What actually addresses "if anything happens there is no recovery": vendors can withdraw
at any time, which shrinks the balance at risk. That is now a real endpoint.

### Decision 18 — Nothing is funded at sign-up; activation is explicit

**Problem raised:** mass account creation could drain the treasury of ALGO.

**Note on the constraint:** an Algorand account cannot receive USDC before opting in, and
cannot opt in without ALGO. So "user deposits USDC first, then we fund" is impossible —
the ALGO must come first. The abuse is nonetheless defeated, for a different reason: the
user never receives the private key, so the ALGO **cannot be extracted**. The worst case is
ALGO temporarily locked in dormant accounts, not theft.

**Chosen:** `ensureWallet()` now only creates the database record. No ALGO is spent until
the user explicitly calls `POST /auth/wallet/activate`. `SIGNUP_USDC_GRANT` defaults to 0 —
no free USDC in any real deployment.

### Decision 19 — Withdrawal reclaims the activation ALGO

A full withdrawal (amount omitted) closes the wallet out: `assetCloseTo` sweeps the USDC
position and `closeRemainderTo` closes the account, returning its whole ALGO balance to the
treasury. Because that recovers the platform's cost, a full withdrawal is **free**. A
partial withdrawal instead transfers `WITHDRAWAL_FEE_USDC` (default 0.1) to the treasury.

Closing also works on an **empty** activated wallet, so an abandoned activation gives its
ALGO back instead of stranding it. `MIN_WITHDRAWAL_USDC` is deliberately not enforced on a
close-out — it must always be possible to empty and shut a wallet.

**Measured on testnet, full user lifecycle:**

| Step                  | Treasury ALGO                                     |
| --------------------- | ------------------------------------------------- |
| Before sign-up        | 9.7960                                            |
| After sign-up         | 9.7960 — **unchanged, mass registration is free** |
| After activation      | 9.5930 (−0.203 lent)                              |
| After full withdrawal | 9.7910 (+0.198 returned)                          |

Net cost of a complete lifecycle: **~0.005 ALGO** in transaction fees. Reclaiming an
abandoned empty activation was verified separately: 9.5890 → 9.7870.

### Decision 20 — Settlement reserves before it pays

`processSettlement` previously returned `null` for four different conditions and could
double-pay if clicked twice. It now returns a discriminated
`PAID | NOTHING_DUE | NO_WALLET | BELOW_MINIMUM | FAILED` result, and writes the settlement
row as `PENDING` **before** the transfer. `getPublisherBalance` counts `PENDING` as already
settled, so a concurrent request sees nothing due rather than paying twice; a failed
transfer flips the row to `FAILED`, releasing the reservation.

Exposed as `POST /dashboard/:publisherId/settle`, behind the existing ownership guard.

### Files changed

**Backend:** `config.ts` (grant default 0, withdrawal fee and minimum), `services/users.ts`
(no auto-provisioning), `services/wallet.ts` (`withdrawUsdc` with close-out),
`services/settlement.ts` (reserve-then-pay), `routes/auth.ts` (`/wallet/activate`,
`/wallet/withdraw`), `routes/dashboard.ts` (`/settle`), `.env.example`.

**Frontend:** new `auth/WalletPanel.tsx` (QR deposit, activate, withdraw — adds the
`qrcode` dependency), `pages/Profile.tsx`, `pages/ConsumerTest.tsx` copy, `api/auth.ts`.
Removed the balance-polling effect from `AuthContext`, which existed only to wait for the
automatic provisioning that no longer happens.

### Still open

The vendor-facing balance and Settle button in the Dashboard UI — the endpoint is live and
guarded, but the dashboard page has not been given the control yet.

---

## Session 6 — 2026-08-15 — Three-account split, credit ledger, subscription top-ups

### Decision 21 — Three accounts, not one

| Account                            | Holds | Role                                                               |
| ---------------------------------- | ----- | ------------------------------------------------------------------ |
| Operations (`TREASURY_MNEMONIC`)   | ALGO  | network fees and any platform giveaway                             |
| Custody (`CUSTODY_MNEMONIC`)       | USDC  | user deposits — unspent credits — and the payer for every API call |
| Settlement (`SETTLEMENT_MNEMONIC`) | USDC  | the x402 `payTo`; earned revenue, source of vendor payouts         |

**Reason:** money held _for_ users, money _earned_ from users, and money _spent running_ the
platform are three different things. Commingling them means an onboarding cost can be paid
out of a vendor's revenue, or a vendor payout out of a user's unspent balance. Each account
now has its own liability check, both reported at boot and on `/health`.

An unset `CUSTODY_MNEMONIC` or `SETTLEMENT_MNEMONIC` falls back to sharing an account and
warns loudly, so an existing deployment keeps running rather than breaking on upgrade.

### Decision 22 — Users hold credits, not wallets

**Chosen:** a user's balance is an append-only ledger (`credit_transactions`); they have no
Algorand account of their own.

**Reason:** the earlier per-user custodial wallet cost 0.2 ALGO to activate and needed an
opt-in _before_ it could receive anything. Pooling into one opted-in custody account
removes that cost entirely — one activated account serves every user — and with it the
whole mass-registration concern. It also drops the ordering constraint that made
"deposit first, fund later" impossible.

Balance is **derived** from the ledger (`SUM(amount)`), never stored as a mutable column,
so it can always be recomputed and can never disagree with its own history. Debits are
written inside a transaction and refuse to take a balance below zero.

**SUPERSEDES** the per-user activation and withdrawal flow from Session 5. That code still
runs; it is retired once the credits UI lands (the user chose to add alongside, not cut over).

### Decision 23 — Every call still settles on chain

**Chosen:** a credit-paid call debits the ledger _and_ signs a real x402 payment from the
custody account to settlement.

**Reason (user's):** funds genuinely move and each call stays independently auditable on
chain. The alternative — pure ledger accounting with periodic vendor settlement — would be
faster and cheaper but leaves no per-call on-chain record.

The debit is applied **after** settlement succeeds and uses the transaction id as its ledger
reference, so a failed payment never costs credit and a debit can always be traced to the
transfer that paid for it.

### Decision 24 — The tier is credited in full

`RECHARGE_TOLERANCE_USDC` exists because network and facilitator costs can mean slightly
less than the tier arrives. The user is credited the full $5 regardless — the shortfall is
absorbed so the balance always matches what they believe they bought.

Recharge requirements are **rebuilt server-side** from the tier. Trusting a client-supplied
copy would let a caller claim a $50 top-up having signed a $1 payment.

### Decision 25 — Wallet connect returns, for top-ups only

Users connect a wallet to buy credits, then never see it again — calls are signed by
custody. This partially reverses Session 2's removal of wallet connect, and the distinction
matters: a popup per _top-up_ is acceptable, a popup per _API call_ is not.

Rejected: a per-user deposit address (needs 0.2 ALGO and an opt-in each), a shared address
with sender matching (orphans exchange deposits), and note-based references (users forget).

### Verified on testnet

- Boot reports three accounts with independent liability lines.
- `$5` top-up: real payment into custody, `credited: 5`, balance 5. Replaying the identical
  signed payment was rejected and the balance stayed 5.
- Two calls at 0.25 USDC: balance 5 → 4.75 → 4.5, each with its own settled transaction
  paid by custody, ledger showing `RECHARGE +5`, `SPEND -0.25`, `SPEND -0.25`.
- Reconciliation exact: users owed **4.5** against custody holding **4.5**; vendors owed
  0.475 against settlement holding 12.56.
- Draining the balance and calling again returns `Insufficient credit` with `topUpRequired`.

### Also fixed

- `POST /publishers/:id/wallet` never validated the payout address — it accepted
  `NOTAVALIDADDRESS` and only failed later during a payout. Now rejected at save.
- Changing a payout address was impossible once any settlement existed: the route deleted
  the `wallets` row that `settlements.wallet_id` references, raising
  `FOREIGN KEY constraint failed`. It now updates in place.

### Still open

The credits **UI** — tier picker, wallet connect for top-up, balance and ledger history —
and retiring the now-superseded activation/withdrawal screens. The fiat onramp endpoint is
scaffolded (HMAC-verified, idempotent on the provider payment id) but no provider is wired.

---

## Session 7 — 2026-08-15 — Mainnet readiness, Bazaar discovery, security audit

### Decision 26 — One variable switches the whole network

`ALGORAND_NETWORK_PROFILE=testnet|mainnet` in `config.ts` derives the CAIP-2 network, USDC
ASA, algod, indexer and explorer URLs from a single table. Individual overrides still exist
but default to blank.

**Reason:** the previous setup needed five values changed together, and getting one wrong —
mainnet network with the testnet asset id — fails every payment in a way that looks like a
facilitator problem. One switch cannot be half-applied. Verified by flipping the variable
and confirming all five derived values change; documented in `mainnet.md`.

### Decision 27 — Bazaar discovery via the official package

Used `declareDiscoveryExtension` from `@x402/extensions` rather than hand-writing the
`extensions.bazaar` object.

**Reason:** the shape is the facilitator's contract, and the package is the authority on it.
Hand-rolling would silently drift. Discovery info is built from what publishers already
supply — `description`, `example_request`, `example_response`, and the schemas — because a
catalog entry is only useful if it says what the caller receives.

Also added `extra.tag = x402-global-challenge` for competition attribution, and an
`x402-merchant` block so every endpoint sharing a `payTo` groups under one merchant.

Verified live: the 402 now carries `extensions: bazaar, x402-merchant`, the tag, and a
concrete description.

### Decision 28 — Credit is reserved before anything is spent on chain

**This was a real, proven exploit, not a theoretical one.**

The old order was: check balance → settle on chain → debit. Concurrent requests all passed
the check, all settled, and only one debit landed. Demonstrated with a user holding credit
for exactly one 0.01 USDC call: three concurrent requests all succeeded, custody paid 0.03,
the ledger deducted 0.01. At scale, $5 of credit drains the custody account.

**Fixed** by debiting first — the debit is atomic and refuses to go negative, so the ledger
is the gate — and refunding via a `REFUND` entry if the payment then fails. Re-running the
identical attack: one success, two `Insufficient credit`, custody down exactly 0.01.

**Lesson worth keeping:** with a check-then-act pattern around money, the check must be the
write. This is the same reservation shape already used for vendor settlements (Decision 20).

### Decision 29 — `/health` no longer exposes the treasury

It returned all three account addresses plus solvency to anonymous callers, mapping the
treasury layout and revealing holdings and liabilities. Public `/health` is now minimal;
the full view moved to `/admin/status` behind `ADMIN_TOKEN` with a constant-time comparison.

### On the "$5 buys exactly $5" rule

Confirmed and already implemented: the user is credited the tier amount, and any shortfall
from network or facilitator costs is absorbed by the platform, recovered through the
`PLATFORM_FEE_PERCENT` taken on the vendor side rather than by shorting the buyer.

### Verified

35 adversarial probes as an outsider with no keys and as a signed-in user trying to cheat;
33 blocked, 2 real findings, both fixed and re-tested. Full results in `SECURITY.md`,
including nine known risks that are documented but not yet closed.

### Still open

The credits UI (tier picker, wallet connect for top-up, balance and history) and retiring
the superseded activation/withdrawal screens. Frontend has not been touched this session.

---

## Session 8 — 2026-08-15 — Credits UI, publisher session auth, seven risks closed

### Competition category: **Composite Entry**

Not Standard (that is one endpoint) and not Orchestration (that is paying into other teams'
endpoints). This is a gateway where every published API endpoint is its own paid route, all
on one domain, all sharing one `payTo` — exactly the composite shape.

The "never share a `payTo` across domains" rule is satisfied: the x402 endpoints all live on
our gateway domain, and publishers' upstream domains sit behind the proxy as an
implementation detail rather than as separate merchants. Listing another team's x402
endpoint as a publisher would make this a hybrid, and those payments would count for both
sides.

### Decision 30 — Wallet connect returns for top-ups, and only top-ups

`TopUpPanel` connects Pera or Defly, signs one payment for the chosen tier, and hands the
payload to `/credits/recharge`. Every API call after that is signed by custody.

**Reason:** the "no wallet popup" goal was always about the _per-call_ experience. A popup
once per top-up is normal; a popup per API call is not. Signing happens in the browser so
the user's key never reaches our server, unlike the custodial keys we hold.

**Cost:** the browser bundle grew from 328 kB to ~1.1 MB because the wallet libraries came
back. They are only needed on the Account page, so lazy-loading the provider is the obvious
follow-up.

### Decision 31 — Publishers authenticate with the session, not a stored API key

`middleware/auth.ts` now resolves the publisher from `users.publisher_id` on the session
first, and only falls back to `X-API-Key`.

**Reason:** the API key lived in `localStorage`, so any XSS on the dashboard could steal a
long-lived credential and redirect a vendor's payouts. An httpOnly cookie cannot be read by
JavaScript at all. The header stays for server-to-server clients, where there is no browser
to attack.

This also fixed unauthenticated publisher creation: `POST /publishers` now requires a session
and takes the email from it, so a caller cannot claim someone else's address. The
long-dormant `users.publisher_id` column finally has a purpose.

### Decision 32 — Redirecting payouts requires an emailed confirmation

Changing `wallets.address` sends a code to the publisher's email and refuses until it comes
back. Setting the address for the first time does not, because there is no revenue to
redirect yet.

**Reason:** the payout address is where the money goes. Every other control is pointless if
a single stolen credential silently reroutes it. Verified end to end: the redirect attempt
returned `confirmationRequired` with the stored address unchanged, a wrong code was
rejected, and only the emailed code applied it.

### Decision 33 — Reconciliation sweep for stranded holds

`/consume` reserves credit before paying and refunds inline on failure, but a crash between
those points would strand the hold. `services/reconciliation.ts` sweeps every 15 minutes for
holds older than 10 minutes with no settlement and no refund. Idempotent by reference.

### Other closures

- Rate limits: `/consume` 120/min per user, recharge 20/min, quotes 30/min, payout change
  10/hour, publisher creation 5/hour per IP, onramp 60/min per IP. Verified: exactly 120
  allowed then 429.
- `email_wallets` is dropped automatically once empty; if rows remain the migration refuses
  and prints the addresses, because dropping it destroys the only copy of those keys.
- Turso sync failures are counted and logged instead of swallowed, with replication health
  on `/admin/status`.

### Deliberately still open

Two risks are infrastructure, not code, and were left with the reasoning recorded rather
than papered over:

- **In-process rate limiting** resets on restart and is not shared between instances.
- **Single-instance SQLite** — the credit ledger's atomicity, which is what stops the drain
  found in Session 7, depends on a single writer. **This is the hard blocker on running two
  instances**; moving to Postgres must come before any horizontal scaling.

---

## Session 9 — 2026-08-15 — Distribution model locked; publisher trust and leak fixes

### Decision 34 — Publishers supply a plain endpoint; the gateway owns the x402 layer

**Chosen (user's call):** a publisher registers a normal HTTP endpoint and a price. The
gateway wraps it with x402, collects one payment, takes the platform fee, and credits the
publisher's ledger balance.

**Rejected — direct pass-through** (front the publisher's own x402 endpoint): the consumer
would pay the publisher's `payTo` directly, so the platform is not in the payment flow and
can take no fee. It would be a link directory, not a gateway.

**Rejected — double settlement** (consumer pays us, we pay their x402 endpoint): two on-chain
settlements per call, roughly double the fee and latency, paid by the consumer, to achieve
exactly what one settlement already does.

**Consequence for the competition:** this keeps the entry purely **Composite**, never hybrid.
Nothing is ever paid downstream to another team.

### Decision 35 — An x402-protected upstream is rejected, not proxied

Because settlement happens before proxying, an upstream that demands its own payment means
the consumer pays us and receives a 402 instead of data. Worse, `health.ts` treated 402 as
healthy (`status < 500`), so such an API published cleanly.

Now: publishing probes the upstream with the endpoint's **real method** and refuses;
the health check treats 402 as OFFLINE; and at runtime an upstream 402 refunds the consumer
and suspends the API.

**Bug found in the fix itself:** the first version always probed with GET, so a POST-only
x402 endpoint answered 404 and slipped through. Fixed to use the endpoint's method.

**Honest limit:** an upstream that validates its body before its payment middleware returns
400 to an empty probe, so publish-time detection cannot be complete. The runtime refund is
the guarantee.

### Decision 36 — Publisher upstream credentials are private and encrypted

`GET /api/apis/:id` was returning `base_url` and `auth_config` to **anonymous** callers.
A live probe returned a publisher's internal URL and their plaintext bearer token — anyone
could have called their API directly, for free, forever.

Withheld from non-owners, and `auth_config` is now encrypted at rest. Verified end to end:
anonymous sees `WITHHELD`, the owner sees their own values, the database column holds
ciphertext, and a paid call still delivers the correct `Authorization` header upstream while
the consumer's cookie does not leak.

### Decision 37 — Publisher trust is verifiable, not asserted

`GET /dashboard/:id/calls` lists every proxied request with the Algorand transaction that
paid for it, plus an `unpaidCalls` count.

**Reason:** a publisher hands us their endpoint and credentials, so "we promise not to call
it for free" is not good enough. They can now reconcile their own upstream access logs
against on-chain settlements independently: a request their server saw that is missing from
this list, or a row with no transaction, is a discrepancy they can raise. The gateway
settles before proxying, so an unpaid call cannot happen by design — this makes that
checkable rather than trusted.

---

## Session 10 — 2026-08-15 — Publisher CLI

### Decision 38 — A CLI for publishers, not SDKs for consumers

The original question was whether to ship SDKs in five languages. The answer split in two:

**Consumer SDKs: no.** x402 _is_ the interoperability layer, and official clients already
exist (`@x402/fetch`, `@x402/axios` for TypeScript, `x402-avm` for Python). Anyone calling a
paid endpoint uses those. Writing our own would duplicate the ecosystem and cost five
release cycles forever. An OpenAPI spec generates clients in 40+ languages for free.

**Publisher CLI: yes.** Publishers are developers, they live in the terminal, and listing an
API is the supply side of the marketplace — which is what actually drives on-chain volume.

**One CLI, not five.** A CLI is a tool, not a library: the language it is written in is
invisible to the user. Node was chosen because `npx` needs no install and the API client
code already existed.

### Decision 39 — Headless auth without weakening the browser

`/otp/verify` returns the raw session token **only** when the caller opts in with
`mode: "token"` or `x-client-type: cli`. It is never the default, because returning the
token in a response body to a browser would hand it to any XSS and undo the httpOnly cookie
work from Session 8. Verified both ways: browser mode returns no token, CLI mode returns one
that works as `Authorization: Bearer …`.

The token is stored in `~/.x402/config.json` at mode 0600, the same treatment an SSH key gets.

### Decision 40 — The CLI never adds x402 code to a publisher's project

"Make my API x402 compatible" means _register it so the gateway makes it payable_, not
inject payment middleware into their service. Injecting it would make their endpoint
x402-protected, which is exactly the double-charge case Decision 35 guards against — their
own publish would then fail.

### Decision 41 — Endpoints persist schemas and examples

`POST /apis/:id/endpoints` now stores `example_response`, `example_request` and both
schemas, and the CLI forwards what it reads from an OpenAPI spec. Without this the Bazaar
entry had a description but no output sample.

Verified: `bazaar.output` now carries
`{"type":"json","example":{"temperature":18.5,"condition":"Partly Cloudy","humidity":65}}`.

### Commands

`login`, `logout`, `whoami`, `init [--openapi]`, `publish`, `status`, `earnings`, `settle`,
`calls`. The manifest is `x402.yaml`, committed alongside the API so listings are versioned
with the code and `x402 publish` can run in CI.

`x402 calls` is the trust command from Session 9: every request with the transaction that
paid for it, so a publisher reconciles against Algorand rather than trusting us.

### Verified end to end

OpenAPI spec → `init` (read 2 endpoints) → `publish` (registered publisher, set payout,
created API, priced, went live) → a real paid call settled at 0.01 USDC → `calls` showing
the transaction → `earnings` showing 0.0095 after the 5% fee.

---

## Session 11 — 2026-08-15 — Frontend moved from Vite to Next.js

### Decision 42 — Next.js is the view layer; Express stays the backend

The frontend moved from Vite + react-router to the Next.js App Router (Next 16, Turbopack).
**Next renders and routes. It does not own any data, auth or payment logic.** No API routes,
no server actions, no Route Handlers were added, and none should be: the Express service
already owns sessions, the x402 gateway, the treasury and the credit ledger.

The recommendation at the time was to stay on Vite — for this app SSR buys little, since every
page except the marketplace sits behind a session cookie, and the wallet adapters are strictly
client-side. The move was made as an explicit product/stack call. What follows is how it was
kept from costing anything.

**Absorbing the backend into Next was never on the table.** Session 6 moved deployment off
Vercel precisely because the backend is a long-running, single-writer, SQLite-backed process
with a cron reconciliation sweep. Folding it into Next would walk that back.

### Decision 43 — The dev proxy became a production rewrite

Vite proxied `/api` and `/x402` to :4402 in development only; in production the static bundle
called the backend cross-origin via `VITE_BACKEND_URL`. That worked only because the session
cookie is `SameSite=Lax`, which a cross-origin XHR does not send — the browser had to be on
the same origin, or the cookie silently vanished.

`next.config.ts` now rewrites both paths to `BACKEND_ORIGIN`, and because the frontend runs as
a Node server (`next start`) rather than a static export, **the rewrite applies in production
too**. `BASE_URL` in `api/client.ts` stays relative (`/api`) by default. The browser only ever
talks to the Next origin, so the cookie works and there is no CORS preflight.

`BACKEND_ORIGIN` is deliberately _not_ `NEXT_PUBLIC_` — it is read by the rewrite engine in the
Node process and must never be inlined into the bundle. `NEXT_PUBLIC_BACKEND_URL` still exists
as an escape hatch for putting the API on a different host, but taking it means loosening the
cookie policy.

Rewrites, not Route Handlers, on purpose: `/x402` carries base64 payment payloads in headers
and proxies the upstream body as raw bytes. A rewrite passes the request through untouched; a
Route Handler is another chance to mangle it.

### Decision 44 — View components live in `src/views/`, not `src/pages/`

`pages/` is reserved by Next for the legacy Pages Router. Leaving the components there made
Next treat them as routes and try to prerender `/ConsumerTest`, which died on `useAuth` outside
its provider. Renamed to `src/views/`. Route segments in `src/app/` hold no logic — they
resolve params server-side and pass them down as props, so `useParams` is gone entirely.

### Decision 45 — Unused wallet adapters are stubbed, not installed

`@txnlab/use-wallet` declares every adapter it supports as an optional peer dependency and
imports them statically. Vite ignored the uninstalled ones; Turbopack resolves the whole graph
and failed the build on five of them. `next.config.ts` aliases the four we do not register
(`@agoralabs-sh/avm-web-provider`, both `@walletconnect/*`, `lute-connect`) to an empty stub,
which keeps WalletConnect and friends out of the bundle.

The fifth, `@blockshake/defly-connect`, was a real gap: `walletManager.ts` has registered
`WalletId.DEFLY` all along without the package ever being installed. Now a dependency.
**If you add a wallet, install its package and drop it from the alias list** — otherwise it
resolves to the stub and fails silently.

### SSR hazards found and fixed

Client components still render once on the server, so browser globals at render time crash the
build. `X402Preview` read `window.location.origin` during render and now resolves it in an
effect; a `typeof window` guard was rejected because it renders one value on the server and
another on the client, tripping hydration. `Header` read `localStorage` in a `useState`
initializer, same fix. Everything else already touched `window`/`localStorage` only inside
effects or event handlers.

### Also changed

- `next/font` self-hosts Inter and JetBrains Mono, replacing the blocking `fonts.googleapis.com`
  stylesheet in the old `index.html`. `--font-sans`/`--font-mono` now point at its CSS variables.
- Tailwind v4 is unchanged; only the plugin host moved (`@tailwindcss/vite` → `@tailwindcss/postcss`).
- `agentRules: false` — Next writes `AGENTS.md` and `CLAUDE.md` into the workspace on dev
  startup otherwise.
- `frontend/railway.toml` runs `next start` instead of serving a static `dist/`.

### Corrections to earlier entries

Two things in `flow.md` were already wrong before this session and are now fixed:
`POST /publishers` requires a session (Decision 31 changed it; the route table still said
"none"), and `/consume` pays from the pooled custody account after an atomic ledger debit
(Decision 28), not from a per-user wallet.

### Verified

Build green, five routes correct. Every route returns 200, `/api` and `/x402` rewrites reach
Express, and a full OTP sign-in through `localhost:5173` set the session cookie and
authenticated `/auth/me` — proving the cookie survives the rewrite.

### Still open

The paid-call path was not re-run end to end after the migration, because it is backend-only
and untouched by this change. The marketplace is still client-rendered — if public SEO is the
reason for being on Next, that page is where the payoff would come from and it has not been
taken yet.

---

## Session — Design system tooling: agent skills, precedence stack, Layer 0

Frontend session. No application code changed. This session installed and reconciled the
skill tooling that later design phases will run under, and fixed two stale documentation
facts. `backend/` and `cli/` untouched.

### Why skills at all, and why a precedence stack

The plan is to rebuild the frontend UI/UX from reference screenshots. Seven agent skills were
selected for that work. Reading them first surfaced the problem: three of them each claim
authority over "anti-generic aesthetics", with **contradictory specific bans**. One bans Inter
as a generic typeface; this repo uses Inter via `next/font`. Left unranked, whichever skill
loads last wins, and the result drifts between sessions — the exact inconsistency the rebuild
is meant to remove.

Resolution: an explicit five-layer precedence stack, lowest layer wins.

```
Layer 0  repo hard rules (Tailwind @theme, no src/pages/, SSR, verify baseline)   ALWAYS WINS
Layer 1  ui.md brand guideline (not yet written)                                  project truth
Layer 2  aesthetic direction — frontend-design, ui-ux-pro-max, design-taste-*     advisory
Layer 3  implementation — vercel-react-best-practices, ponytail                   advisory
Layer 4  audit gate — web-design-guidelines, then npm run verify                  blocking
```

Layer 0 is the load-bearing one. **None of the seven skills knows this repo's silent-failure
modes** — the `@theme` utility rule, the `src/pages/` reservation, the SSR render-path
constraints. Unguarded they will emit `bg-[var(--color-panel)]` and inline `style={{}}`,
which pass typecheck and fail silently. Rejected the alternative of trusting skill quality:
these failures are invisible, not loud, so trust is the wrong mechanism.

Layer 3 tension recorded deliberately: ponytail wants less code, the aesthetic skills want
motion and detail. Neither vetoes the other — **ponytail governs logic, aesthetics govern
presentation.**

### Two skills evaluated and handled differently

- **`design-taste-frontend`** — installed, but scoped. It self-declares "Not dashboards, not
  data tables, not multi-step product UI", which is four of this app's five views. It applies
  to `Marketplace` only. Its own header states its rules are contextual and do not fire
  automatically, so the scoping is cooperative rather than imposed.
- **`stitch-design-taste`** — **not installed.** It generates a `DESIGN.md` for _Google Stitch_
  to consume, and there is no Stitch in this pipeline; the artifact would have no reader. Its
  document structure was borrowed into the `ui.md` outline instead. Rejected installing it
  "just in case" — an installed skill with no consumer is a source of contradictory advice.

### Two merged skills, deliberately split

Both are **invoke-only**: their descriptions instruct agents not to auto-trigger, so ordinary
component edits do not drag the whole pipeline into context.

| Skill                    | Scope                        | Why there                                                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design-system-pipeline` | global (`~/.agents/skills/`) | Process only — phases, precedence, conflict table. Repo-agnostic, so it is reusable. Opens with a preflight that **asks** rather than assumes, because similar-looking repos (Next + Tailwind) can be a marketing site, a dashboard, or a docs portal and the right direction differs |
| `x402-design`            | repo (`.agents/skills/`)     | Layer 0 rules, token inventory, surface map, skill routing. Travels with the repo                                                                                                                                                                                                     |

The split exists so the process survives without the repo, and the constraints survive without
the process. Rejected a single merged skill: it would have hard-coded x402 facts into
something meant to be portable.

`.agents/skills/` was chosen over `.claude/skills/` because the `skills` CLI installs there and
symlinks outward to 17 different agents — Codex, Cursor, Gemini CLI, Copilot and others. That
makes the setup genuinely model-agnostic, matching this file's own stated goal.

### Superseded

**The plan from the previous session — add four semantic colour tokens and replace the 35 raw
palette usages — is deferred, not cancelled.** Doing it now would be thrown away: the whole
palette is being replaced from screenshots in Phase 2. The finding that caused it still stands
and is recorded in `x402-design` as the design brief: no `success/warning/error/info` tokens
exist, which is _why_ 35 raw palette values and one dead `text-warning` got improvised.

One constraint discovered while scoping that fix, now recorded so Phase 2 does not trip on it:
`--color-glass` is already `rgba(...)`, so it cannot take a Tailwind alpha modifier. New state
tokens must be opaque hex or the existing `bg-red-500/10` pattern has no replacement.

### Corrections

- **`verify.md` was stale on the baseline.** Gate 1 claimed "0 errors, 141 warnings" and the
  known-debt table claimed 139 `any`. Measured: **63 warnings — 61 `any`, 2 `exhaustive-deps`**.
  Both fixed. The file instructs readers to keep that number meaningful, so a wrong number is
  worse than none.
- **`next-session.md` names the wrong file for the dead class.** `text-warning` is in
  `components/steps/ApiInfo.tsx:197`, not `X402Preview.tsx`. Corrected in `x402-design`;
  `next-session.md` is a disposable handoff note and was left alone.

### Also changed

`.prettierignore` now excludes `.agents`. The installs added 88 third-party markdown files and
`format:check` failed on all of them, breaking Gate 1. Reformatting vendored skill content
would be wrong — it is not ours, and it is overwritten on update.

### Verified

`npm run verify` green: 0 errors, **63 warnings** (baseline held), all five routes plus
`/_not-found` present. `scripts/security-review.sh`: **39 passed, 0 failed, 0 unverified** —
including S9.1/S9.2/S9.3, the frontend silent-failure checks.

### Still open

`.agents/` is untracked and not gitignored. Committing 88 vendored third-party files versus
committing only `skills-lock.json` plus `x402-design` is a repo-size-vs-reproducibility call
that has not been made. Nothing downstream depends on it yet.

Phases 1 and 2 are blocked on the reference screenshots. `taste.md`, `ui.md` and `PAGES.md`
do not exist yet.

---

## Session — Design system Phases 1 and 2: taste.md and ui.md

Frontend session, continued. 22 reference screenshots decoded into `taste.md`, then four
decisions taken and written into `ui.md`. **No application code changed.** `backend/` and
`cli/` untouched. Phases 3 to 5 (page specs, demo, rollout) not started.

### Phase 1 — what the references actually said

19 unique shots (three were duplicates). Seven rules recur strongly enough to be signal:
off-black backgrounds with a cool cast rather than `#000000` (16 of 19); mono uppercase
carrying all metadata (10); dot-matrix, halftone and dither as the image treatment (10);
an instrument/specification aesthetic of alignment marks and label/value pairs (6);
monochrome plus exactly one accent, usually under 5% coverage; small solid rectangular CTAs;
and large display type against notably small body type.

Every rule in `taste.md` names the shot it came from. Rules without attribution were treated
as inventions and left out.

**The most useful single finding: shot `17` (a product spec sheet) is close to a literal
layout spec for this product.** A payments platform's core content _is_ label/value pairs —
transaction ID, payment hash, amount, settlement status. That became the `spec row` pattern in
`ui.md` §5.1 and is now the default way to present data in this app, ahead of cards.

Recorded honestly in `taste.md` §5: the reference set is almost entirely hero moments. It has
**zero coverage** of data tables, forms, wizard chrome, modals, or any error/empty/loading
state — which is four of the five views. Type and layout rules extend to those surfaces;
colour-under-state does not.

### Phase 2 — the four decisions

**Accent is blue.** Rejected orange despite shots `1` and `5` being the loudest references in
the set, because of a product constraint that outranks taste: red must mean payment failure.
An orange or red brand accent would compete with error semantics, and the fix would have been
shifting errors to magenta — unconventional and harder to read as failure. Blue keeps red free.

**`info` aliases `accent`.** A blue accent plus a blue `info` state puts two blues on screen
competing for the same meaning, breaking the one-accent rule every reference obeys. There is
one blue. The separate token exists only so call sites can express intent and so the two can
diverge later. If they must diverge, `info` changes, never `accent`.

**Type is Space Grotesk + JetBrains Mono.** Inter is retired — both `frontend-design` and
`design-taste-frontend` flag it as a generic default, and that conflict was recorded as open
during setup. Verified in `next/font/google` rather than assumed: `Space_Grotesk` exports with
weights 300–700 plus variable, subset latin. **It has no italic.** Emphasis must come from
weight or colour; shot `7`'s italic serif display is not reproducible with this pairing, which
is the trade accepted in choosing a grotesque over a serif.

**Light theme is derived, not observed.** Only one reference is light, and it is a poster.
Values were chosen against contrast targets rather than by inverting the dark theme — inverting
is precisely what produced the current palette, where light values were never chosen
deliberately. `ui.md` marks the whole light column as derived so a later pass can replace it
with evidence.

**Imagery is dot-matrix primary, SVG line-art secondary**, per the user's brief. Shot `13`
is the load-bearing one: dot _size_ encodes the value, proving the motif can carry data rather
than only decorate. Dot-matrix must be generated (canvas or CSS), never a raster asset —
a PNG would not respond to the theme switch, which is the same class of bug as the 35 fixed-hex
palette values it replaces.

### Contrast was computed, not asserted

All 42 foreground/surface pairs across both themes were measured against WCAG. Two failed on
first pass — dark `accent-dim` at 4.38 on `panel` and 3.96 on `panel-hover` — and the token was
lightened from `#2E7FD4` to `#4A93E8`. **Every pair now meets AA for body text (≥ 4.5:1).**
Tightest remaining margin is light `success` at 4.63; `ui.md` records that it may be darkened
but not lightened.

Separately recorded: `border` sits at 1.41:1 dark and 1.33:1 light, far below the 3:1 a
meaning-bearing boundary needs. That is deliberate — borders are structural hairlines. Anything
a user must perceive (focus ring, error outline, selection) resolves to `accent` or a state
colour instead. A focus ring drawn in `border` would be invisible and fail an audit.

### Token count 9 to 13

Adds `success`, `warning`, `error`, `info` — the gap identified two sessions ago as the root
cause of both the dead `text-warning` and the 35 improvised palette values. All four are
**opaque hex**, deliberately, so Tailwind alpha modifiers keep working: `bg-red-500/10` maps
cleanly to `bg-error/10`. `--color-glass` stays `rgba()` and is documented as the one token
that cannot take an alpha modifier.

### Verified

`npm run verify` green: 0 errors, 63 warnings (baseline held), five routes plus `/_not-found`.
`scripts/security-review.sh`: 39 passed, 0 failed, 0 unverified.

### Still open

`ui.md` §8 defines a fourth enforcement grep for raw palette values, intended to become `S9.4`
in `scripts/security-review.sh`. **It is not added yet** — the 35 existing usages would fail it
immediately. It goes in at the end of Phase 5, and `security-review.md` gets the matching
catalogue entry in the same change.

`.agents/` is still untracked and not gitignored; that call from the previous session stands
open. Phases 3 to 5 not started.

---

## Session — Design system: batch 2 references close the coverage gap

Continuation. 28 further screenshots supplied grouped by category — tables, forms, wizard
chrome, modals, error/empty/loading — covering exactly the surfaces the previous session
recorded as unreferenced. `taste.md` gained §6 and §7; `ui.md` revised in four places.
**No application code changed.**

### Attribution method changed, deliberately

Batch 1 rules cite a shot number. Batch 2 arrived grouped by category rather than numbered, so
its rules cite `category / descriptor` instead. Rejected inferring a numbering from message
order: the attributions are the whole value of `taste.md`, and a confidently wrong shot number
is worse than an honest descriptor a human can check.

### The gap is closed

The previous session recorded that state colour had **no evidence** and was derived from
contrast and convention alone. That is now only half true, and `ui.md` §2.5 says so rather than
being quietly rewritten. Batch 2 supplies two observed status treatments — bare coloured text
with no container, and a tinted chip where grey means paused rather than absent. The _hues_
remain conventional; the _treatment_ is now observed.

Also newly grounded: table behaviour (no zebra striping in any of eight references, hover to
the next surface value, mono for machine values), the vertical wizard rail, modal footer
ordering, and per-context empty states.

Two independent confirmations worth noting. `other / Quinstreet` runs the exact label-left
value-right spec row that `ui.md` §5.1 had already specified from shot `17` — arrived at
independently, and it also answers the mobile question (rows stack, long values wrap rather
than truncate). And `other / Apple silicon` plus `charts / Hexbin` both encode magnitude as a
count of discrete marks, the same method as shot `13`, from two more directions.

### Three contradictions between batches, resolved

Recorded in `taste.md` §7 rather than silently resolved, then decided:

**C1 radius — batch 2 wins.** 2/4/8px becomes **4/8/12px**. Batch 1 is posters, batch 2 is
application UI; the rounder values come from the shots that are the same kind of artifact as
this app. Posters can be sharp because they contain no controls to soften. `rounded-full`
still banned except on avatars.

**C2 shadows — narrowed, not reversed.** The previous total ban is now **in-page surfaces get
no shadow, overlays get separation**. One `--shadow-overlay` token plus a scrim that blurs the
page behind rather than flatly dimming it. Rejected a full sm/md/lg elevation scale: batch 1
uses zero shadows and a scale would immediately be misused on cards. The §8 enforcement grep
still fails any `shadow-{sm,md,lg,xl,2xl}` utility.

**C3 categorical colour — a separate system, not an exception to the accent rule.** Batch 2's
multi-hue tag pills only contradict the one-accent rule if categorical and semantic colour are
treated as the same problem. They are not: categorical encodes _which bucket_, semantic encodes
_how healthy_, and a `Technical` tag rendered in the warning ramp reads as a warning.

The app has a real categorical dimension — 21 references to `skills`, driving `SkillSelect`.
Four semantic hues are already spoken for (blue 210°, green 152°, amber 38°, red 0°), leaving
little uncollided hue space. Rather than invent six hues that quietly clash, **the chip stays
neutral and only a 6px dot carries the hue.** The text label is the real signal. Because the
dot is a non-text mark it needs 3:1 rather than 4.5:1, and hue proximity to a semantic colour
matters far less inside a neutral container than as a fully tinted pill.

Six categorical hues added, measured against `panel` in both themes: **all 12 pairs pass 3:1**,
tightest `cat-3` light at 3.52. Assignment is by stable hash of the skill name, never array
index — index assignment changes every colour when a skill is inserted.

### Also added to ui.md

Three new primitives, all newly evidenced: **Table** (the densest surface in the app, and the
one with the most batch 2 coverage), **Wizard rail** (onboarding is 10 steps; a horizontal
stepper does not fit a viewport at that count, and every reference uses a vertical left rail),
and **EmptyState**. Modal gained the blurred scrim, the two-pane multi-step form, and the
destructive-action-far-left convention — which matters here because unpublishing an API and
withdrawing settlement are irreversible and must not sit adjacent to `Cancel`.

Colour tokens now 19, up from 9 at session start.

### Verified

`npm run verify` green: 0 errors, 63 warnings (baseline held), five routes plus `/_not-found`.
`scripts/security-review.sh`: 39 passed, 0 failed, 0 unverified.

### Still open

Unchanged from the previous session: the `S9.4` raw-palette check waits until the 35 existing
usages are gone, and `.agents/` is still untracked and not gitignored. Phases 3 to 5 not
started — `PAGES.md` does not exist and no demo has been built.

---

## Session — Component gallery built, and five live revisions to ui.md

Phase 4 opened: a browsable component gallery rendering every token and primitive, at
`scratchpad/design-system.html`. Throwaway HTML with real tokens inlined and a theme toggle —
**no application code changed.** Five revisions came from reviewing it.

### Electric blue, and what it cost

`accent` moved from `#5AA9FF` to **`#33A1FF`** (light `#0A66C2` to `#0059B8`), `accent-dim` to
`#2790E8` / `#00458F`.

Saturation costs contrast headroom, so candidates were measured rather than eyeballed.
**`#0A84FF` — Apple's system blue, the obvious "electric" pick — was tested and rejected** at
4.46:1 on `panel-hover`, below AA. `#0066FF` and `#0F62FE` fail the same way in light. The pair
chosen holds all 42 foreground/surface pairs at AA, worst now dark `accent-dim` at 4.84.

Themes were hue-matched deliberately: 208° dark against 214° light, 3° drift. Brighter cyan-ward
options scored better on contrast but would have made the brand read cyan in dark and indigo in
light.

### The electric accent broke the categorical ramp

Moving `accent` to 208° put it **nine degrees from `cat-4` cyan `#38BDF8` (199°) at similar
lightness**. A skill dot would have read as _selected_. Colliding with the accent is the one
collision this system cannot absorb, so cyan was removed: **six categorical hues became five.**

Investigating that surfaced something larger. `SkillSelect` offers **19 skills** against 5 hues,
so roughly four skills share each colour by construction. Colour was never going to identify a
skill. `ui.md` now says so explicitly rather than implying uniqueness — the dot is a scanning
aid, the label is the identifier, and that is exactly why the chip stays neutral and the dot
stays small. A fully tinted pill would promise a distinctness that does not exist.

### StatusBadge lost its container

Now **a dot plus text, both in the state colour. No background tint, no border, no box.**

The chip drew a box around something already unambiguous, and at table density a bordered pill
on every row is noise. `taste.md` §6.2 already recorded `table / Claritas` doing exactly this
with bare coloured text. The dot preserves the non-colour signal that dropping the container
would otherwise lose, so §2.5 still holds.

Worth noting the consequence: without a tint behind it, the state colour is text on `panel` or
`bg` directly, so **its AA ratio is what carries it** — 4.63:1 at worst. The tinted form could
have concealed a weak colour behind a container. This one cannot, which is a reason to trust it.

### Frosted glass, deliberately weak

Requested "low, not too much, better readability". Added `--glass-blur: 10px` and raised
`--color-glass` opacity to 0.88 dark / 0.94 light.

**The constraint that makes frost safe here:** every contrast ratio in §2.2 assumes an _opaque_
backdrop. A translucent surface inherits whatever sits behind it, so at low opacity the measured
4.5:1 stops being a guarantee. Holding opacity at 0.88 or above keeps worst-case backdrop
influence under roughly 12%, which existing headroom absorbs. Frost is therefore permitted on
sticky header, scrims, dropdowns and toasts, and **forbidden on cards, tables, rows and inputs**
— anything holding body text over arbitrary content.

`backdrop-filter` is also unsupported in some contexts, so the rule is that `--color-glass` must
stay legible with no blur at all. Never rely on blur to create contrast.

### Icons

Base set stays **`lucide-react`** — already a dependency at `^1.31.0` with 20 import sites, and
it matches the hairline line-art language.

**`lucide-animated.com` adopted selectively**, with facts recorded rather than assumed: there is
no npm package (icons install per-icon through the shadcn CLI as vendored source), it **pulls in
Motion as a new dependency**, it is MIT, and vendored icons will not track upstream updates.

**Recorded as unverified:** the shadcn CLI normally expects a `components.json` and this repo has
none. Whether `shadcn add` works here without an init step has not been tested, and `ui.md` says
so — better found now than mid-rollout.

Animation is restricted to real state changes (payment settling, copy-to-clipboard, verification
passing) and **banned on anything repeated down a list**, where motion reads as a glitch.
`prefers-reduced-motion` must still render the final state, never nothing.

### Verified

Gallery: tag nesting validated programmatically — 0 unclosed, 0 mismatched — and opened in a
browser. Screen capture was unavailable (no display permission), so visual confirmation is the
user's, not automated; that is why the file is browsable rather than screenshotted.

Repo: `npm run verify` green — 0 errors, 63 warnings (baseline held), five routes plus
`/_not-found`. `scripts/security-review.sh` 39 passed, 0 failed.

### Still open

Colour tokens now 18. `PAGES.md` still does not exist and no real page has been touched. The
`S9.4` raw-palette check and the untracked `.agents/` decision both carry over unchanged.

---

## Session — Skill tags de-boxed, and the control/label split it forced

Follow-up to the gallery review. Skill tags now match the `StatusBadge` treatment: **no
container, dot plus label.** No application code changed.

### One deliberate difference from status

Status colours its text; a skill tag does not. **Status _is_ the colour** — settled, failed,
pending — so tinting the word reinforces the meaning. A skill is a name, and tinting nineteen
skill names across five recycled hues would imply a distinctness the colour does not carry.
Only the dot takes hue; the label stays `text-main`.

### De-boxing forced a component split

Removing the container broke something that was not obvious until the box was gone: in
`SkillSelect` the tag is a **control**, not a label. With no box there is nothing to click and
no way to render a selected state.

So the tag is now two components, and `ui.md` §2.6 says so:

- **Tag** — tables, cards, API detail. No container, dot plus neutral label
- **Option** — the `SkillSelect` step only. Keeps `bg-panel`, `border-border`, a 6px/12px hit
  target, and `border-accent` plus a ring when selected

Rejected applying the boxless form everywhere: it would have looked consistent in a screenshot
and been unusable in the wizard. The same visual simplification is correct for display and
wrong for input, which is the distinction worth recording.

### Verified

Gallery tag nesting revalidated — 0 unclosed, 0 mismatched — and reopened in the browser.
Visual confirmation remains the user's; screen capture is unavailable in this environment.

---

## Session — Vercel-aligned neutrals: pure black, no hue cast, borders carry the structure

Gallery review continued. Four changes, the last of which overrides a batch 1 rule. **No
application code changed.**

### Selection highlight moved off accent

Selected options were using `border-accent` plus a ring. Now **neutral**: `border-main`,
`panel-hover` fill, and a check mark.

Three reasons, in order of weight. **Focus and selection were both resolving to `accent`**, so
a keyboard user focusing an already-selected option saw one signal doing two jobs; focus stays
accent, selection goes neutral, and both are now visible simultaneously. It also protects the
§2.4 accent budget — selection is everywhere in this app (wizard options, nav, table rows) and
spending accent on all of it would blow the under-5% rule immediately. Third, it matches the
Vercel reference, where the active nav item is a neutral fill with no colour at all.

The check renders at `opacity: 0` when unselected rather than being absent, so selecting does
not change the element's width. A mark that appears on select causes layout shift.

### Pure black, and the structural consequence

`bg` is now `#000000` / `#FFFFFF`. **This overrides `taste.md` §1.1**, which recorded that 16 of
19 batch 1 shots use off-black with a cool cast. The override is deliberate and justified by a
later reference — the Vercel dashboard — being far closer to this product than a poster is.

The second change matters more than the first: **the neutral ramp no longer has a hue cast.**
Previous values were blue-tinted (`#131719`, `#949DA6`); they are now true greys (`#0E0E0E`,
`#A1A1A1`).

The consequence is structural, not cosmetic. **`panel` sits at 1.16:1 against pure black, so a
surface no longer separates itself by fill.** Borders stop being decoration and become the
primary means of defining a box — which is exactly how the Vercel reference reads, and why
`--color-border` was strengthened to `#2E2E2E` rather than left alone. The user's instinct
("boxes same, just add borders") and the measurement agreed.

Contrast improved rather than suffered: worst dark pair 4.84 → **5.17**, worst light
4.63 → **4.73**. All 42 pairs still AA.

### Not claimed as Vercel's tokens

Geist's colour documentation was fetched and **does not publish hex values** — it describes the
system and exposes CSS variable names only. These values were read from the supplied screenshots
and then contrast-verified here. `ui.md` §2.1a says this explicitly, so nobody later cites them
as Vercel's palette.

### One divergence from the Vercel reference, left alone deliberately

Vercel renders status as a **coloured dot with neutral text** (`● Ready` — green dot, white
word). This system currently colours both dot and text, because that was an explicit earlier
instruction.

Not silently changed. Flagged for the user instead: matching Vercel here would also make status
mechanically identical to the skill tag (dot carries hue, label stays neutral), which would be
one fewer rule to remember.

### Verified

Gallery revalidated (0 unclosed, 0 mismatched) and reopened. `npm run verify` green — 0 errors,
63 warnings, five routes plus `/_not-found`. `scripts/security-review.sh` 39 passed, 0 failed.

---

## Session — Design system rebuilt as a Geist-style documentation site

The gallery became a **documentation site** modelled on Vercel's Geist docs, at
`scratchpad/ds/index.html`. Still throwaway HTML, still zero application code changed.

### Why the structure changed, not just the styling

The flat scrolling gallery listed tokens. Geist's structure — sidebar, grouped navigation,
per-component pages with a live preview above a code line — does something the gallery could
not: **it doubles as the reference an engineer reads during Phase 5 rollout.** Each component
now shows the utility classes to type, so the demo and the implementation guide are the same
artifact rather than two that can drift apart.

Structure adopted from Geist, adapted to what this project actually has:

| Geist       | Here                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundations | Introduction, Colors, Typography, Space & radius, Depth & motion                                                                                                      |
| Assets      | Replaced by **Patterns** — spec row, mono label, imagery. This system's signature moves are compositional, not asset-based, so an asset section would have been empty |
| Components  | Button, Input, StatusBadge, SkillTag, Card, Table, WizardRail, Modal, EmptyState                                                                                      |

17 sections, fixed sidebar with scroll-spy, theme toggle, hex values read live from the
computed CSS variables so the swatches cannot fall out of sync with the tokens.

### The page obeys its own rules

Worth recording because it is the strongest available test of the system: the documentation
site is built _from_ the tokens it documents. Pure black ground, boxes defined by borders rather
than fill, mono caps for every label, spec rows for label/value data, neutral selection on the
active nav item, accent spent only on focus and the primary button.

If the system were unusable for a dense information layout, building this page would have
surfaced it. It did not.

### Verified

Structural validation rather than assumption: 0 unclosed tags, 0 mismatched, and **all 17 nav
anchors resolve to a real section** — a broken sidebar link is the obvious failure mode for a
hand-written docs page. Opened in the browser; visual confirmation remains the user's, since
screen capture is unavailable in this environment.

Repo untouched: `backend/`, `cli/` and `frontend/src` all unchanged this session.

### Still open

The Vercel divergence flagged last session is unresolved: Vercel renders status as a coloured
dot with **neutral** text, while this system colours both. Left as specified rather than changed
silently. `PAGES.md` still does not exist; no real page has been touched.

---

## Session — Motion layer, font candidates, softer borders

Three changes to the documentation site and `ui.md`. **No application code changed.**

### Motion: three durations, two curves

Replaced the placeholder `--duration-fast/base/slow` set with values tuned to feel like
response rather than transition.

| Token     | Value | Applies to                                |
| --------- | ----- | ----------------------------------------- |
| `--dur-1` | 90ms  | Press — buttons and options scale to 0.97 |
| `--dur-2` | 140ms | Hover, colour, focus ring, row highlight  |
| `--dur-3` | 200ms | Overlays, disclosure, theme swap          |

**Enter and exit now use different curves**, which the previous single-curve spec got wrong. A
decelerating exit feels reluctant; things leaving should accelerate away. Enter is
`cubic-bezier(0.16, 1, 0.3, 1)`, exit is `cubic-bezier(0.4, 0, 1, 1)`.

Two rules recorded because they are the ones that get broken:

- **Only `opacity` and `transform` animate.** Both composite on the GPU. Animating `width`,
  `height`, `top` or `margin` reflows on every frame.
- **Anything that appears must have its space reserved.** The copy check and the option tick
  render at `opacity: 0` when inactive rather than being absent — an element that appears on
  interaction causes layout shift at the exact moment the user is looking at it.

Interactions built and demonstrable in the docs site: button press, option press, row hover,
focus ring, copy morphing to a check and reverting after 1.5s, and a **working modal** with
scrim-click and `Esc` dismissal. Nothing loops; nothing animates on an element repeated down a
list.

`prefers-reduced-motion: reduce` drops every duration to 0.01ms and removes press transforms.
The state change still occurs — it simply arrives instantly.

### Display face reopened

Space Grotesk was flagged as reading too common. Rather than swapping it unilaterally, six
candidates were **verified present in `next/font/google` against the local font data** and wired
into a live switcher in the docs site, so the choice is made by looking rather than by reading
adjectives.

Candidates: Space Grotesk (current), Bricolage Grotesque, Instrument Sans, Schibsted Grotesk,
Familjen Grotesk, Geist.

**The italic finding is the useful part.** §3.1 recorded "Space Grotesk has no italic" as an
accepted trade. Four of the five alternatives have a true italic, so switching would remove that
constraint from the system rather than merely changing its appearance. Geist is noted with a
caveat: it matches the Vercel reference exactly, which may be the intent or may be too close.

Mono stays JetBrains Mono regardless — it carries the label, ID and numeral roles.

### Borders softened

`#2E2E2E` → `#242424` dark, `#D4D4D4` → `#E2E2E2` light. Ratios against `bg` drop from
1.55/1.48 to **1.35/1.30**.

This sits in tension with the earlier decision that borders define boxes because `panel` is only
1.16:1 against pure black. Softening them is still safe: at 1.35:1 the edge remains perceptible
while no longer competing with content. But the margin is now thinner, and `ui.md` §2.3 carries
the new numbers so a future softening is made with the trade visible rather than by feel.

### Verified

Docs site revalidated — 0 unclosed tags, 0 mismatched — and every interactive handler
(`openModal`, `closeModal`, `copyDemo`, `setFont`) confirmed present and wired to markup rather
than assumed. Opened in the browser; visual and tactile confirmation is the user's.

`npm run verify` green: 0 errors, 63 warnings. `scripts/security-review.sh` 39 passed, 0 failed.

---

## Session — Docs site rebuilt to the real Geist layout

Rebuilt `scratchpad/ds/` as a three-file app — `index.html`, `app.css`, `app.js` — matching the
Geist documentation layout from the supplied screenshot. **No application code changed.**

### Layout corrected against the actual screenshot

The previous version guessed at Geist's shape from a text description. The screenshot showed
three things that guess got wrong:

1. **The brand block sits over the sidebar column, flush left**, with its own right border — the
   top bar is split at the sidebar boundary rather than running full width
2. **Code is a `Show code` disclosure row beneath the preview**, not a Preview/Code tab pair.
   The preview stays visible when code opens, which is the point — you compare them
3. **Content is left-aligned with full-bleed section rules**, not a centred column

The right-hand "On this page" TOC was removed: Geist does not have one on component pages, and
with per-page routing each page is short enough that it was scaffolding for a problem that no
longer existed.

### Single file, hash routing

Chosen over 17 separate HTML files. Each route renders as its own page with breadcrumb, title
and prev/next pager, and the back button works — but one set of tokens means a colour change
cannot desynchronise across pages. Seventeen files would have needed a build step to stay
honest.

18 routes across Foundations, Patterns and Components. Collapsible sidebar groups, ⌘K palette
with arrow-key navigation, copy buttons on every code block, and hex swatches read live from
computed CSS variables so they cannot drift from the tokens.

### Font switcher expanded to 25

Grouped by character — Grotesque, Product/neutral, Geometric, Expressive, Serif. **The font URL
was fetched and confirmed HTTP 200 before shipping it**, rather than assuming 27 families
resolve; a silently-failing font link would have made every candidate render as fallback and
look identical, which is the exact failure this switcher exists to prevent.

The display face decision stays open by request. Space Grotesk remains the default in `ui.md`
§1 until chosen from the switcher.

### Verified

0 unclosed tags, 0 mismatched, **18 routes and 23 demo blocks** confirmed present by parsing the
generated file rather than trusting the generator. Repo baseline untouched: `npm run verify`
green at 0 errors / 63 warnings.

### Still open

Display face. The Vercel status divergence (they use a neutral label beside a coloured dot;
this system colours both). `PAGES.md` does not exist and no real page has been touched.

---

## Session — Docs site centred and polished; pager matched to Geist

Layout corrections driven by two screenshots of the running page and of Geist itself. **No
application code changed.**

### Two real defects the screenshot exposed

1. **Content hugged the sidebar with a dead gutter on the right.** `main` was left-aligned, so
   on a wide viewport the column sat against the nav with several hundred pixels of unused space
   beside it. `main` now centres its column (`display: flex; justify-content: center`) inside the
   space remaining after the sidebar.
2. **The section rule stopped short of the content width.** It was using a negative margin tuned
   to the old padding, so it neither spanned the column nor aligned to it. Rules now span the
   content column exactly, which reads as deliberate rather than clipped.

Both were only visible by looking at the rendered page. Neither would have failed any structural
check — a reminder that tag validation proves wiring, not layout.

### Pager rebuilt from the Geist footer

Was two bordered cards. Geist uses **text only**: a muted "Previous"/"Next" label above the page
title, with a chevron that shifts 3px on hover, left- and right-anchored across a top rule. Boxes
made a navigation aid look like a content card; removing them matches both Geist and this
system's own rule that borders define boxes, and a link is not a box.

### Polish

- Theme control became an **icon button** with sun/moon swapped by `[data-theme]` in CSS, and the
  redundant `DARK` text label was removed
- Table cells lost their left padding so the first column aligns to the text column above it;
  non-first cells capped at 34ch to stop the sprawl visible in the screenshot
- Row hover changed from a background fill to a text-colour lift — a fill on a borderless table
  read heavier than intended at this density
- Lede narrowed to 62ch, sidebar rhythm tightened, demo stages given a minimum height so short
  previews do not collapse

### Verified — and one bug caught by it

Cross-checked every `getElementById` in `app.js` against the HTML, and every inline handler in
the HTML against the JS. That surfaced a **real bug**: removing the `DARK` text label deleted
`#themeName`, but `tog()` still wrote to it, so the first theme click would have thrown and left
the theme half-switched. Fixed before opening the page.

`node --check` on the JS, brace-balance check on the CSS after regex surgery, both clean. Repo
baseline untouched.

### Still open

Display face. The Vercel status divergence. `PAGES.md` does not exist; no real page touched.

---

## Session — Type scale raised two steps, shell compacted

Both driven by looking at the rendered page. **No application code changed.**

### Scale raised, mono held

Body 14px → **16px**, display 56px → 64px, every sans role with them. The original 14px was
justified by the references being uniformly small-type — but those references are posters and
marketing pages seen at a distance, not a dashboard read at arm's length for an hour. At real
size the scale sat too tight. `ui.md` §3.2 now carries that reasoning rather than the old
justification, which was honest at the time and wrong in practice.

**The mono roles deliberately did not move.** `text-label` stayed 12px and `text-micro` 11px
while every sans role grew. Letterspaced uppercase mono reads visually larger than its nominal
size, and enlarging it would cost the _small label_ character the whole system leans on. The
label-to-body ratio tightened from 0.79 to 0.75, which is the intended direction.

Applied by a single-pass regex map over `font-size` declarations only — a naive sequential
replace would have cascaded each value through every later mapping and compounded the bump.

### Shell compacted

`--shell` 1460 → 1320, `--sidebar` 268 → 240, content column widened 880 → 940 with padding cut
48 → 36. Net effect: the content sits noticeably closer to the nav instead of floating in the
middle of a wide empty band. Vertical rhythm tightened throughout — head padding, rule margins,
sub-heading margins, demo padding, pager spacing.

Widening the column while narrowing the shell is what actually closes the gap; shrinking the
shell alone would have kept the same dead space and just moved it.

### Verified

Brace balance on the CSS after each regex pass, scale tables in both `ui.md` and the docs page
synced to the same numbers so they cannot drift. Repo baseline held: 0 errors, 63 warnings.

### Still open

Display face, the Vercel status divergence, `PAGES.md`. Plus a component inventory gap now worth
recording — see next entry.

---

## Session — Content pipeline, router, and agent-agnostic entry point

Six skills installed and three files written. No application code changed.

### Installed

`seo-aeo-best-practices`, `ai-seo`, `programmatic-seo`, `documentation-writer`, `humanizer-zh`,
`i-have-adhd` — all to `.agents/skills/`, so they work across every agent, not just Claude.

**Three deliberately not installed.** `technical-seo-checker` has been relocated out of the repo
it advertises and carries a Snyk warning; `technical-writer` duplicates `documentation-writer`,
which uses Diátaxis and is the more rigorous of the two.

**Three deferred by decision, not oversight:** `seo-audit`, `seo-technical` and
`firecrawl-seo-audit` all need a live crawlable URL. They are planned for post-deploy and
recorded as Phase 6 in `content-pipeline`.

On Firecrawl specifically — its skill wraps a hosted crawler, and the audit it produces (titles,
meta descriptions, headings, internal links, canonicals, alt text) can be generated by crawling
the deployed site directly. Recorded as a preference for doing it ourselves rather than adding a
paid dependency for something already achievable.

### The finding that shapes all of it

`/` (Marketplace) is the only public page in the product, and it is **client-rendered** — it
fetches in an effect and returns empty HTML to a crawler. Everything else sits behind a session
cookie.

So the entire SEO surface today is one page that serves no content. **No SEO skill can fix
that** — it is an architecture problem, and it is already logged as `next-session.md` issue 3.
`content-pipeline` states it in its preflight so no future agent produces an audit that reports
"no content found" and calls it a result.

### Three files

**`AGENTS.md`** — repo entry point, deliberately short. Points at `x402-router` and indexes
every document with _when_ to read it, rather than restating their contents. Safe to create
because `next.config.ts` sets `agentRules: false`, so Next will not overwrite it on dev startup.

**`.agents/skills/x402-router/SKILL.md`** — the orchestrator. Classifies a request into
frontend/UI, content/SEO, docs, verification or backend, then **asks before entering the flow**
and loads only that flow's documents. Two paths get extra friction by design: backend/CLI
requires explicit confirmation because those are marked verified, and an unclear request is
never guessed at.

Its own first rule is _route, do not do_ — the failure mode for an orchestrator is quietly
becoming the implementer.

**`.agents/skills/content-pipeline/SKILL.md`** — six phases with a precedence stack, same shape
as `design-system-pipeline`. Layer 0 is **what the product actually does**, above positioning and
above every SEO opinion. For a payments product an invented capability is a liability, not a
marketing error.

Two conflicts resolved explicitly: `programmatic-seo` owns the page _set_ while `ai-seo` owns the
_inside_ of a page, which stops them colliding; and `humanizer-zh` runs **last** and is barred
from touching API names, error strings, amounts or code — its job is removing AI cadence, not
editing terminology. Its Mandarin documentation and unverified English behaviour are recorded so
its output gets read rather than trusted.

### `.agents/product-marketing.md`

Written from verified sources only — `README.md`, `flow.md` §4, the `verify.md` invariants table
— with every claim attributed. Six items are marked `⚠ UNVERIFIED` and barred from copy until
answered: product name in prose, domain, logo, platform fee, launch stage, target queries.

Recorded there because it changes the audience model: **the consumer is often an AI agent, not a
person.** Agent-readable structure and `llms.txt` are the primary channel here, not a side quest.

### Verified

`npm run verify` green — 0 errors, 63 warnings. `scripts/security-review.sh` 39 passed, 0 failed.

### Still open

The SSR fix on `/` gates all content work. Display face for the design system. `PAGES.md`.

---

## Session — Placeholder convention for undecided values

Brand name, fee percentage, domain and logo are all still open, so content work needed a way to
proceed without inventing any of them. No application code changed.

### Greppable tokens, not plausible stand-ins

`{{BRAND}}`, `{{FEE_PCT}}`, `{{DOMAIN}}`, `{{LOGO}}`. The double-brace form appears in no real
code, so a single grep finds every unresolved value and becomes a release gate:

```bash
grep -rn "{{[A-Z_]*}}" frontend/src .agents
```

Rejected inventing a working name to fill the gap. **A plausible fake survives review; a token
does not** — which is the entire point. A placeholder reaching production is a naming failure,
and this converts it into a build failure.

Tokens render in `warning` with a dashed border wherever they appear, so they are also
impossible to miss in a screenshot.

### Art placeholders are generated, never raster

New **Placeholders** page in the design system (28 routes now). Logo mark is a 5×5 dot grid
built from a fixed bit pattern — deterministic, theme-responsive, and on-system, since
dot-matrix is already the house imagery treatment. Image slots are a low-density dot field
carrying their intended aspect ratio and a dimension label.

Two reasons recorded for refusing a raster placeholder:

- **A PNG survives into production because nothing flags it.** A generated one is obviously
  provisional and cannot be mistaken for a finished asset
- **A placeholder of the wrong aspect ratio hides the layout problem** until the real asset
  arrives, at which point the fix is expensive

The docs-site wordmark now reads `{{BRAND}}` beside the generated mark, so the tool demonstrates
its own convention rather than describing it.

### Verified

28 routes, HTML and JS route lists in sync, 0 unclosed tags, 9 tokens present and rendering.

### Still open

Brand name and fee percentage — both half-answered (shape decided, value not). Domain, logo,
target queries. Display face. SEO deferred until live by decision.
---

## Session — Fee model decided: 3%, no flat fee

### The question

Whether to add a flat per-transaction fee on top of the percentage, as Visa and Mastercard do.

### What card rails actually do, and why

Card pricing is percentage **plus** fixed — roughly 2.9% + $0.30 online once interchange,
assessment and processor markup are combined. The fixed component exists because every
authorization carries a real fixed cost regardless of amount: a network round trip, fraud
scoring, a settlement record, chargeback administration. A $1 sale costs nearly what a $500 sale
costs.

That fixed component is precisely why micropayments never worked on cards.

### Why copying it would be wrong here

Two reasons, the second decisive.

**Call sizes make it absurd.** At a 0.025 USDC call, a $0.01 floor is a 43% fee and a card-style
$0.30 floor is over 1,200%.

**There is no equivalent fixed cost to recover.** Checked the settlement path rather than
assuming: `flow.md` §4 shows the payment group as `[0]` a fee-payer transaction **the facilitator
signs and pays**, and `[1]` a USDC axfer from custody carrying **`fee 0`**. The platform's
on-chain cost per call is effectively nil — marginal cost is a facilitator round trip and a
database write.

Card networks charge a floor because they burn real money per authorization. This does not.

### The positioning consequence

**The absence of a per-transaction floor is the story, not the 3%.** "No minimum, no per-call
floor" is something card rails structurally cannot offer. Adding a flat fee would trade that
differentiator away to recover a cost that is not being paid.

Recorded rule: if a real fixed cost appears later, **raise the percentage rather than adding a
floor** — a percentage stays honest at every call size.

### One thing that could change this

Whether the facilitator bills per settlement. That is a GoPlausible contract term, not visible
in the repo, and it is the obvious candidate for a genuine fixed cost. Logged as `⚠ UNVERIFIED`
in `product-marketing.md` rather than assumed either way.

### Effect

`{{FEE_PCT}}` is resolved and struck from the token table; three tokens remain — `{{BRAND}}`,
`{{DOMAIN}}`, `{{LOGO}}`.

---

## Session — Fee model: three discrepancies found between stated intent and code

Investigating the flat-fee question surfaced three mismatches. **No code was changed** —
`backend/` is marked verified and off-limits. Recorded for a future backend session to resolve.

### 1. Rate: intent 3%, code default 5%

`backend/src/config.ts:124` — `PLATFORM_FEE_PERCENT: parseFloat(process.env.PLATFORM_FEE_PERCENT || '5')`.

Env-overridable, so the running deployment may be 3. But the default is 5, and any instance
started without that variable takes 5%. **Publishing "3%" as a claim while the code can take 5%
would be a false statement about money**, which is why `product-marketing.md` now blocks stating
any rate until the two agree.

### 2. The fee is charged on gross, not on net-after-facilitator

`backend/src/routes/gateway.ts:195`:

```js
const fee = pricing.price_per_request * (config.PLATFORM_FEE_PERCENT / 100);
const publisherRevenue = pricing.price_per_request - fee;
```

The percentage is taken from the **full list price**. The facilitator's cut is not subtracted
first, contrary to the described model of "3% of what remains after the facilitator cuts".

This is more favourable to the platform than the described model, but it means the publisher
absorbs the facilitator fee twice: once as the deduction itself, and again because the platform
cut was computed before it.

### 3. The facilitator's fee is never recorded — possible solvency drift

Grepped the backend: only `feePayer` appears, which identifies _who pays the ALGO gas_, not _how
much USDC the facilitator takes_. No amount is captured. The `usage` table books `revenue`,
`platform_fee` and `publisher_revenue` from the list price alone.

`verify.md` carries a solvency invariant — vendor liability in USDC against USDC held. **If the
facilitator deducts from the USDC while `publisher_revenue` is booked as though it did not, the
recorded liability to publishers exceeds the USDC actually received, and the gap compounds per
call.**

Recorded as a question rather than an assertion: the missing record is visible in the code, but
whether GoPlausible deducts from the payment or bills separately is a contract term not in the
repo. The user's account is that it deducts, which is the case that produces the drift.

### Minimum call price — right decision, different reason

The chosen protection stands, but the reasoning in the previous entry was wrong. Because the
platform cut is a percentage of a positive number, **the platform cannot go underwater**. The
floor protects the **publisher**: at a small enough call a fixed facilitator cut consumes most
of what they would receive, and the platform carries the blame.

Formula recorded for once the facilitator number is known:

```
minimum_call_price >= facilitator_fee / 0.10
```

which caps the facilitator at 10% of any call.

### Why this is filed and not fixed

`backend/` is verified working and out of scope by standing instruction. Three separate money
paths are involved — the rate default, the calculation basis, and the settlement accounting —
and none should be touched inside a frontend session.

---

## Session — Fee model resolved at 5%; one real exposure remains

Follow-up. Decision: **keep 5%**, facilitator cuts at transaction time, platform takes its share
at settlement. Two of the three previously-recorded discrepancies close on inspection. **No code
changed.**

### Closed: the rate

5% is the stated intent and `PLATFORM_FEE_PERCENT` already defaults to 5. They agree.
`product-marketing.md` now permits stating the rate in copy.

### Closed: the calculation basis

The previous entry flagged the fee being computed on gross as a mismatch with "cut at
settlement". Reading `settlement.ts:87` shows it is not a mismatch — it is accrual:

```js
// `available` sums usage.publisher_revenue, which the gateway already recorded net of
// the platform fee — deducting it again here would charge the publisher twice.
const amount = balances.available;
```

The 5% is **booked per call and realised at payout by never being paid out**. That is exactly
the intended model, and the code already carries a comment guarding against double-deduction.
The earlier concern was wrong and is corrected here rather than left standing.

### Open, and sharper than before: the facilitator fee erodes the margin

The facilitator deducts from the payment at transaction time. The ledger books
`publisher_revenue` off the **gross** price. So:

```
consumer pays                P
facilitator takes            F        at transaction time
settlement account receives  P − F
platform books publisher     0.95P    off gross, F never subtracted
platform actually retains    0.05P − F
```

**Real margin is `0.05P − F`, not `0.05P`.** It turns negative when the facilitator's fee exceeds
5% of the call price:

```
break-even call price = F / 0.05 = 20 × facilitator fee
```

Below that the platform pays publishers more than it received, and the settlement account drains.

The symptom is already coded for. `settlement.ts` returns
`Settlement account holds X USDC but Y is due. Top it up and try again.` **That message is the
drain indicator** — if it fires without an obvious cause, this is the reason.

### Minimum call price — now computable

| Goal                 | Floor     |
| -------------------- | --------- |
| Break even           | `20 × F`  |
| Retain half the 5%   | `40 × F`  |
| Retain 80% of the 5% | `100 × F` |

Only one input is still missing: what GoPlausible charges per settlement. Recorded as the sole
remaining `⚠ UNVERIFIED` item on the fee model.

### Still not fixed, deliberately

The facilitator fee remains unrecorded in the `usage` table, so `publisher_revenue` continues to
overstate what was actually received. That is a backend accounting change and `backend/` is
verified and out of scope for this session.
---

## Session — Facilitator fee measured on chain: it is zero

The previous entry recorded a margin exposure of `0.05P − F` and a break-even call size, based on
the account that GoPlausible deducts a fee from each payment. **Measured it instead of asking for
the number. F is zero.** That entry's conclusion is superseded.

### Method

Two settled calls already existed in `usage` from an earlier e2e run, both at 0.01 USDC. Rather
than spending testnet funds on five new price points, queried the Algorand indexer directly for
the recorded transaction — free, read-only, and conclusive.

### Result

Payment group for transaction `HKHWZ277…`, testnet round 66333425:

| Txn         | Sender                  | Network fee | Moves                                     |
| ----------- | ----------------------- | ----------- | ----------------------------------------- |
| `[0]` pay   | Facilitator `ZMFK2OI7…` | 2000 µALGO  | 0 ALGO to itself                          |
| `[1]` axfer | Custody `OCNNBZZX…`     | 0           | **10,000 µUSDC → Settlement `AJE46YPJ…`** |

10,000 µUSDC is exactly 0.01 USDC. **The full call price reached the settlement account. The
facilitator deducted nothing from the USDC.**

What its fee-payer transaction actually does is pay 0.002 ALGO of network fees on the platform's
behalf — it subsidises gas, it does not take a cut. That is precisely why the consumer never
needs ALGO.

### Consequences

- **Real margin is a clean 5%**, not `0.05P − F`
- **No break-even call size**, so no sub-break-even calls to protect against
- **No minimum call price needed for platform solvency.** The earlier `20 × F` formula is moot
- **The unrecorded-facilitator-fee accounting concern is void** — there is no deduction to record,
  so `publisher_revenue` is not overstating and the solvency invariant is not drifting

The previous two entries reasoned correctly from a false premise. Recording the correction rather
than quietly editing them, per this file's own rules.

### Why the proposed five-price test was not run

A percentage cut would have been visible at 0.01 USDC: 10,000 micro-units means even a 0.1% fee
shows as 10 units missing. Nothing was missing, so a percentage model is excluded down to about
0.01%. Spending 3.61 testnet USDC to confirm what one existing transaction already proves would
have been waste.

### Remaining uncertainty, stated honestly

- **Testnet only.** Mainnet terms may differ; re-measure before `mainnet.md` is executed
- **Out-of-band billing.** A subscription or monthly invoice from GoPlausible would not appear on
  chain. The user's belief that the facilitator costs them money may be true but billed elsewhere
- **One price point, n=2.** A single 2 USDC call would exclude a threshold or tiered model, at a
  cost of 2 USDC rather than 3.61

### Boot check, incidentally

The backend was started read-only to read its solvency lines. Clean boot, no `Warning:` lines.
Settlement holds 12.64 USDC against 0.019 liability; custody holds 4.42 against 0.070 outstanding.
Both solvent.

---

## Session — Semantic tokens applied, S9.4 added, marketplace server-rendered, responsive pass

Four items delivered together. **Baseline improved on both axes: 63 → 61 warnings, 39 → 40
security checks.**

### Semantic tokens: added, not swapped

Added `success`/`warning`/`error`/`info` plus `cat-1…5` to `frontend/src/styles/index.css`, in
`@theme` and both `[data-theme]` blocks. **Deliberately did not touch the existing nine surface
tokens or the fonts** — the pure-black palette and the display face are Phase 5 proper and the
font is still undecided. Migrating call sites needed only the new tokens to exist.

Contrast was recomputed against the **live** palette (`#0a0a0a`/`#141414`/`#1e1e1e`), not the
redesigned one in `ui.md`. All 8 semantic pairs clear AA and all 10 categorical pairs clear 3:1.

### 36 raw palette values migrated

`red → error`, `green → success`, `yellow → warning`, opacity suffixes preserved. Nine files.
The count was 36, not the 35 previously recorded — the original survey missed one hue.

`text-warning` at `ApiInfo.tsx:197` is now real rather than dead.

**Verified in the built CSS, not assumed.** `.text-warning{color:var(--color-warning)}` — it
resolves through the variable, so theme switching works.

One scare worth recording: `bg-error/10` compiles to a literal `#ff5c5c1a`, which looked like a
baked dark-theme value that would ignore the light theme. Reading further showed Tailwind emits
**both** — the hex first, then the same rule inside `@supports (color: color-mix(...))` using
`var(--color-error)`. Progressive enhancement. Every current browser takes the variable form and
follows the theme; the hex is the fallback for engines without `color-mix`.

### S9.4 added

New check in `scripts/security-review.sh` and the matching row in `security-review.md` — the two
must never disagree. It fails any raw Tailwind palette colour in `frontend/src`. Added **after**
the migration, since adding it first would have failed the build immediately.

40 passed, 0 failed.

### `/` is now server-rendered

`app/page.tsx` became a server component that awaits `api/marketplace.ts:getMarketplaceApis()`
and passes `initialApis` down. `Marketplace.tsx` stays a client component for search and filter,
but its fetch effect and loading branch are gone.

Two decisions recorded:

- **Absolute `BACKEND_ORIGIN`, not the `/api` rewrite.** The browser is relative to an origin;
  the server is not. Reused the same variable `next.config.ts` rewrites to
- **`revalidate: 60`, and `[]` on failure rather than a throw.** The route stays `○ Static` with
  ISR, so it is cheap and crawlable. A marketplace rendering empty is recoverable; a page that
  throws during render is a 500 for every visitor, crawlers included

**Verified by building twice.** With the backend down the page prerendered with no listings —
confirming the fetch is real. With the backend up, `e2e-weather-v0os0` appears in
`.next/server/app/index.html`. The listing is now in the HTML.

Side effect: removing the hand-rolled `any` mapping in the effect dropped two lint warnings.

### Responsive

Ten `grid-cols-2` instances across eight files gained a `grid-cols-1 sm:` base — two columns of
form fields at 320px was unusable. One was reverted deliberately: the Marketplace card's inner
stat pair sits inside a card that is already full-width on mobile, so stacking only added height.

Marketplace hero now scales `text-3xl sm:text-4xl md:text-5xl`, its forced `<br />` became a
responsive `block sm:inline` (the hard break produced an orphan at 320px), and container padding
steps `px-4 sm:px-6`.

Two global rules in `index.css`, both with the reason inline:

- `-webkit-text-size-adjust: 100%` — mobile Safari inflates text in landscape otherwise, undoing
  every sized heading the moment the phone rotates
- `overflow-wrap: break-word` on `body` — transaction IDs, payment hashes and Algorand addresses
  are long unbroken strings; one of them forces the page wider than the viewport and everything
  below inherits the horizontal scroll

### Docs updated in the same change

`verify.md` baseline 63 → 61 with the new breakdown, `flow.md` §7 records the server/client split
and why, `security-review.md` gains the S9.4 row.

### Still open

Brand name, domain, display face. Full palette and font rollout (Phase 5) remains pending the
font. `PAGES.md` not written.

---

## Session — Text wrapping, overlay clipping, and breakpoints in one place

Three fixes, all found by looking at the rendered page rather than by any check.

### "Design System" wrapped to two lines

The docs-site brand block is a fixed 240px holding a mark, a wordmark and a label — too much, so
the label wrapped. That is exactly the failure the user had already asked to avoid, and no
structural check catches it.

Fixed at the class level rather than the instance: **nothing in the chrome wraps.** `nav-link`,
`nav-head`, `searchbtn`, `eyebrow`, `demo-toggle`, `t-label` and `t-micro` all take
`white-space: nowrap`, with nav links truncating to an ellipsis rather than growing. The brand
label hides below 1240px instead of wrapping.

**Applied the same rule to the real app**, in `@layer base` so it is set once rather than
remembered as `whitespace-nowrap` at every call site:

```css
button,
[role='button'],
th,
label,
.badge,
nav a {
  white-space: nowrap;
}
h1,
h2,
h3,
h4 {
  text-wrap: balance;
}
p {
  text-wrap: pretty;
}
```

Verified present in the built CSS, not assumed. The principle recorded in `ui.md` §4.7: if a
label does not fit, shorten it or hide it at that breakpoint — never let it wrap. A two-line
button reads as a rendering glitch, not a design choice.

### The tooltip was being clipped

`.demo` carried `overflow: hidden`, which cut off any tooltip escaping the box. **This is a real
pattern problem, not a docs-site one** — a tooltip inside any `overflow-hidden` card clips the
same way, and the app has six such containers in `Dashboard.tsx`.

The `overflow: hidden` existed only to round the corners of the stage and code children. Removed
it and gave those children their own radii instead, so overlays can escape. Also added a `.below`
variant that flips the tooltip under its trigger when there is no room above.

Recorded in `ui.md` as a rule: **overlays must never sit inside `overflow: hidden`.** The
clipping is invisible until someone hovers, which is the worst kind of bug — it passes every
review that does not involve a mouse.

### Breakpoints now live in exactly one place

Six `--breakpoint-*` tokens in the `@theme` block, named by what changes at that width rather
than by device. Editing one moves every `sm:` / `md:` / `lg:` utility in the app.

Confirmed there are **zero hand-written `@media (max-width: …)` queries** in `frontend/src`
outside `prefers-reduced-motion`. That is what makes the single source of truth actually single,
and `ui.md` §4.6 now says so explicitly so the next person does not add one.

### Verified

`npm run verify` green — 0 errors, 61 warnings. `scripts/security-review.sh` 40 passed, 0 failed.
The base-layer rules confirmed in the built CSS output.

---

## Session — Selection highlight inverts the surface

The browser default selection blue was unreadable over `muted` text, which is most of the body
copy in this system.

Replaced the app's previous `rgba(255,255,255,0.15)` — itself too low-contrast — with an
inversion:

```css
::selection {
  background: var(--color-main);
  color: var(--color-bg);
}
```

**One rule covers both themes.** `main` and `bg` already swap per theme, so dark mode renders
white-on-dark and light renders dark-on-white with no second rule and no `[data-theme]` branch.
Both land at 17.8:1.

Applied to the app and the docs site, plus `::-moz-selection` for Firefox. Verified present in
the built CSS. Recorded in `ui.md` §4.7.

---

## Session — Banned vocabulary, bracket placeholders, filled banners

### The site does not name the payment rail

New hard rule in `product-marketing.md` §6a. These appear nowhere in user-facing copy, metadata,
titles or alt text: `Algorand`, `blockchain`, `crypto`, `stablecoin`, `USDC`, `wallet`,
`on-chain`, `web3`, `micropayment`, `gas`.

**This is positioning, not squeamishness.** The audience is a developer who wants an API call to
work. The settlement mechanism is an implementation detail that happens to be excellent — leading
with it filters out everyone not already crypto-native, which is most of the market. The
mechanism is also what makes "no signup, pay per call" possible, so the copy describes the
_outcome_ and lets the mechanism stay invisible. A substitution table is recorded alongside.

Cleaned the public page immediately, since `/` is the only crawlable surface: the metadata I had
written said "settled in USDC on Algorand", and the hero said "Pay Per Use with USDC" and "Stream
micropayments on Algorand". Both rewritten.

Two carve-outs recorded rather than silently applied:

- **Code identifiers are out of scope.** `usdcAssetId`, `walletAddress` and similar are not copy.
  The ban is on what a reader sees. 98 raw matches exist across 16 files; most are identifiers
- **The `Blockchain` skill category stands.** It is a value in the backend's `AVAILABLE_SKILLS`
  and drives marketplace filtering. Changing it is a backend edit, which is out of scope

**Exempt pages are `⚠ NOT YET DEFINED`.** The user will name pages where the mechanism _is_ the
subject — a technical explainer or trust page. Until named, the ban is total. Recorded as a
pending input rather than guessed at.

### Placeholders now `[TOKEN]`

`{{BRAND}}` → `[BRAND]`, and the release-gate grep updated to `\\[[A-Z_]{3,}\\]`. Applied in
`product-marketing.md` and the docs site.

### Banner redesigned

Was a tinted border on a transparent background. Now **solid fill in the state colour, fully
rounded**, with text and dot in `--color-bg`.

The inversion is the same trick as `::selection`: `bg` swaps per theme, so one rule gives
near-black text on a bright fill in dark mode and white on a dark fill in light. **Contrast is
symmetric**, so these are the same pairs already measured as state-on-`bg` — no new measurement
needed.

This overrides §4.2's "no `rounded-full` except avatars". Recorded as a deliberate exception with
its reason: a banner is a single-line interruption, not a panel, and the pill shape says notice
rather than content.

The demo copy also carried banned vocabulary ("your custody wallet is being created") and was
rewritten in the same pass.

---

## Session — Sticky tooltip fixed, avatars became identicons

### Tooltip stayed open after a click

`:focus-within` was the cause: clicking the trigger focuses it, so the tooltip stayed up after
the mouse left. Replaced with `:has(:focus-visible)` — keyboard focus still opens it, a mouse
click does not leave it stuck.

**A real pattern bug, not a demo artefact.** Any tooltip built with `:focus-within` behaves this
way, and it only shows up if someone clicks rather than hovers. Documented on the page so the
next implementation does not repeat it.

### Avatars are now generated, not initials

A 5×5 dot grid mirrored down the centre, pattern from an FNV-1a hash of the name. Same person,
same avatar, every time.

This resolved a tension that was already in `ui.md`. The file banned name-hashed background
colour, because tinting an avatar by hash makes it read as a status when hue is reserved for
state and category. But initials alone are weak at distinguishing people at 28px.

**A dot pattern carries the distinguishing power without borrowing meaning it should not have.**
Identity comes from the pattern; the avatar stays monochrome; both rules hold.

Deterministic by construction — no `Math.random()`, so server and client agree and the avatar
never changes between renders. The overflow chip (`+4`) stays as text: a count is not an identity.

---

## Session — Page width shifted between routes

The docs page changed width when navigating. `scrollbar-gutter: stable` was already in place, so
it was not the scrollbar.

**Cause: `min-width: auto` on flex items.** `main` is a flex container and `.page` a flex item
with `width: 100%; max-width: 940px`. Flex items default to `min-width: auto`, which lets them
grow past a max-width when a child is wider — the Table demo did exactly that, so routes with a
table rendered wider than routes without.

Two fixes, both needed:

- `min-width: 0` on `main`, `.page` and `.demo-stage` so the max-width is actually binding
- Tables inside a demo now scroll in their own box (`display: block; overflow-x: auto`) rather
  than widening their container. Body cells keep `white-space: normal` so only the header row
  stays on one line

Worth recording because the symptom pointed at the wrong cause: a width change on navigation
looks like a scrollbar problem, and the scrollbar fix was already applied and correct.

---

## Session — Responsive rebuilt against a real device ladder

Tested at 22 real viewports from 320px to 2560px. Three failures, one of them total.

### The topbar collapsed into itself below ~900px

Brand, search, breadcrumb, font picker and theme button all overlapped. `.topbar` was a flex row
with a fixed-width brand block and nothing set to hide or shrink, so below about 900px the
children simply stacked on top of each other.

Fixed with a **shedding ladder** rather than squeezing: each breakpoint drops the least
load-bearing thing still on screen.

| Width  | What goes                                              |
| ------ | ------------------------------------------------------ |
| 1240px | Brand sub-label                                        |
| 1100px | Breadcrumb — it duplicates the page title anyway       |
| 900px  | Font picker; sidebar becomes a drawer; shell frame     |
| 640px  | Search collapses to an icon; grids drop to two columns |
| 380px  | Grids drop to one column; display sizes step down      |

### There was no navigation at all on a phone

The sidebar was `display: none` below 900px. Every screenshot from 320 to 853px had **no way to
navigate** — the single worst failure in the set, and it had been there since the shell was
built.

Now an off-canvas drawer: hamburger in the brand block, scrim behind, `276px` capped at `82vw`,
closing on route change and on `Esc`. Recorded in `ui.md` as a rule — a sidebar hidden at a
breakpoint must become a drawer, never simply disappear.

### Table columns were colliding

`VALUEAPPLIES TO` ran together, and `90ms` touched `Press.`. Caused by an earlier change that set
`padding-left: 0` on cells to align the first column with the text above it — which also removed
the gap between every column. Restored a 28px right padding, with the last cell exempt so the
right edge still aligns.

Worth noting: that alignment fix was correct and its side effect was invisible until a table with
three narrow columns was viewed at a phone width.

### Minimum supported width is now stated: 320px

The app's `--breakpoint-xs` was 480px, above several real devices. Moved to 400px, and the device
ladder recorded in `ui.md` §4.6 rather than left implicit — **344px (Z Fold folded)** and
**540 × 720 (Surface Duo)** are the two that get forgotten: narrow enough to break a two-column
grid, wide enough that nobody thinks to test them.

### Verified

Handler and element-id cross-check clean, `node --check` on the JS, brace balance on the CSS.
`npm run verify` green — 0 errors, 61 warnings. Visual confirmation across the device ladder is
the user's; screen capture is unavailable here.

---

## Session — I destroyed most of the docs CSS, and the check I was running could not see it

### What happened

The previous entry's responsive work was applied with a Python slice:

```python
old_start = s.index('@media (max-width: 1460px) {')
s = s[:old_start] + NEW_MEDIA_BLOCKS
```

That takes everything before the marker and appends the new blocks — **discarding every rule
after it.** `app.css` went from 1631 lines to 559. Every component style from `.route` onward was
gone: the router's `display: none`, all primitives, tables, demos, avatars, toasts. The page
rendered every route stacked on top of each other with almost no styling.

### The check passed anyway, and that is the real lesson

Brace balance came back 0 and the media-block count looked right, so it read as success.
**Deleting whole rules keeps braces balanced** — the check was structurally incapable of
detecting the failure. It measured syntax, not content.

The user found it by looking at the page. Nothing automated would have.

### Recovery

Claude Code's own `file-history` had `@v10`, the last version before the slice — complete at
1631 lines. Restored from there, then re-applied the three changes with **bounded replaces**: the
900px media block was matched in full and swapped for the new ladder, rather than slicing to
end-of-file.

### Rules taken from this

- **Never slice to end-of-file when patching a structured file.** Match the region to replace in
  full and assert it was found. Every other edit this session used `assert old in s` and none of
  them caused damage; the one that skipped it did
- **A syntax check is not a content check.** Balanced braces, valid JSON, a clean `node --check`
  — all of these survive mass deletion. Verify that things that should exist still do
- The post-restore check now asserts every class the HTML references is defined in the CSS, and
  reports a rule count (293). That would have caught this

### State after recovery

1756 lines, 293 rules, braces balanced. Handler cross-check, element-id cross-check and
class-coverage check all clean. `node --check` passes. The responsive ladder, mobile drawer and
table-padding fix are all present and applied correctly.

---

## Session — Brand resolved: Spigot, spigot.sh

### Availability was checked, not guessed

Earlier suggestions were labelled "likely available" from intuition. That was wrong: `whois`
against `whois.nic.sh` showed **12 of 14 taken**, including `sluice`, `shunt`, `picket`, `egress`
and `docket` — all of which had been predicted free. Only `stile.sh` and `turnpike.sh` were
available from the first list; a second batch of 24 surfaced `artery`, `spigot`, `lintel` and
`girder`.

Recording the method because the lesson generalises: obscurity is not a proxy for availability,
and the check costs one command.

### Spigot, and why not Stile

`stile.sh` was the recommendation. The user rejected it because **stile and style are
homophones** — a name that is ambiguous when spoken aloud or typed from memory is a liability,
not a quirk. That is a better test than distinctiveness and it was the right call.

**Spigot** is a tap that controls flow — metering and gatewaying in one word, which holds as the
product evolves toward an MCP gateway with an audit trail. `npx spigot init` reads correctly.

`x402` stays the **protocol** reference in technical contexts only. The brand is never built on
it; it is Coinbase's open specification, not this product.

### Applied

`[BRAND]` and `[DOMAIN]` resolved across `product-marketing.md` and the docs site. The wordmark
lost its dashed placeholder underline. Root `layout.tsx` metadata rewritten: it still said
`x402 Gateway Platform` and _"get paid per request in USDC on Algorand"_, violating both the old
name and the §6a vocabulary ban. Now carries `metadataBase`, a title template and Open Graph.

One correction during the work: a blind `[BRAND]` → `Spigot` replace also rewrote the token
**examples inside the placeholder-convention section**, which exist to explain the convention.
Restored, with the resolved values noted alongside rather than substituted into the rule.

`.dev` was proposed at the ₹1000 budget; the user raised to ₹5000, which `.sh` fits. `.ai` was
ruled out on a factual constraint rather than taste — the registry requires a two-year minimum,
putting it at ₹13,000–20,000 up front.

### Still `⚠ UNVERIFIED`

Logo (the dot-grid mark is a placeholder), exempt pages for the vocabulary ban, target search
queries.

---

## Session — Display face decided: Schibsted Grotesk

Replaces Inter in the app and Space Grotesk in the docs site. The font question had been open
since the design system began and was gating the Phase 5 rollout.

### Why it matters beyond appearance

**Schibsted Grotesk ships a true italic.** `ui.md` §3.1 had recorded "Space Grotesk has no
italic" as an accepted constraint — emphasis was restricted to weight and colour, and shot `7`'s
italic display was noted as unreproducible. **That constraint is now gone**, which is a real
capability gain rather than a change of appearance. The old note is marked superseded rather
than deleted.

Verified in `next/font/google` and self-hosted at build time: 10 woff2 files emitted, the
`--font-schibsted` variable resolving in the built CSS, no third-party request. Weights 400–700,
both styles.

Mono stays JetBrains Mono — it carries the label, ID and numeral roles and is unaffected.

### Logo — cannot proceed yet

The user supplied an image intended as the logo. **It is a macOS file-type icon**, not the
artwork: Brave is the default `.svg` handler on this machine, so Finder rendered Brave's lion
glyph on a generic document shape. Searched `~/Downloads`, `~/Desktop` and the repo — no `.svg`
present.

Recorded rather than guessed at. The stated intent is three variants — black, white and a blue —
with **the system accent shifting to the logo's blue**. That last part matters: `--color-accent`
is load-bearing (focus rings, primary action, links) and every one of the 42 contrast pairs in
`ui.md` §2.2 was measured against the current `#33A1FF`. A new blue requires re-measuring, not
substituting.

---

## Session — Brand blue applied, single typeface, logo installed

### The logo blue cannot be the dark accent

`SPIGOT_logo_SHARP_editable_Figma.svg` is a single-path mark, one colour: **`#0049FD`**, hue 223°.

Measured before applying, and it fails on dark: **3.37 / 3.10 / 2.79** on `bg` / `panel` /
`panel-hover`, against a 4.5 requirement. On light it is comfortable at 6.23 / 5.97 / 5.56.

So the themes diverge, deliberately:

- **Light uses the logo value exactly** — `#0049FD`
- **Dark uses `#4D7FFF`** — the _same hue_ (223°, identical), lightened until it clears AA at
  5.80 / 5.33 / **4.80**

Holding the hue constant and moving only lightness is what makes the brand read as one colour
across themes. Substituting a different blue would have been faster and wrong.

`accent-dim` follows: `#7099FF` dark, `#0038C7` light. Both AA. `info` tracks `accent` as always.

### Logo installed

`frontend/public/logo.svg` (brand blue) and `logo-mono.svg` (`currentColor`). One `currentColor`
file serves all three requested variants — black, white and blue — because the theme decides the
colour. Inlined into the docs site replacing the placeholder dot grid; the dot grid is retained
on the Placeholders page, which is what it documents.

### One typeface

The font switcher and its 25 candidates are gone. The stylesheet request dropped from 27 families
to 2 — Schibsted Grotesk and JetBrains Mono — and the URL was verified HTTP 200 rather than
assumed. A switcher was right while the choice was open; keeping it after would invite drift.

### Frame rules stopped short

The full-height shell rules ended above the topbar. `.frame` was `top: 0; bottom: 0` with
`z-index: var(--z-sticky)`, so the topbar's own background painted over them. Now `inset: 0` at
`--z-header`, spanning the viewport at every scroll position.

---

## Session — Mark goes blue, sized up, and becomes the favicon

Three small changes, one with a side effect worth recording.

The mark now renders in `accent` rather than `main`, so **the mark carries the colour and the
wordmark stays neutral**. Because `accent` already resolves per theme, one inlined
`currentColor` SVG produces the logo blue on light and the lightened same-hue variant on dark
with no second asset.

Sized 22px → 30px. A mark matched to the wordmark's cap height reads smaller than the text beside
it, because the letterforms have no ascenders in `Spigot` beyond the `S` and `p`.

**Favicon:** `frontend/src/app/icon.svg`. Next's App Router serves it automatically — and lists
it as a route. `verify.md`'s expected route table now shows **seven** entries rather than six,
with a note that `/icon.svg` is not a page and its absence means the brand mark has gone. That
table is a hard check, so leaving it stale would have failed the next verification run for the
wrong reason.

The docs site uses a base64 data-URI icon instead, since it has no build step to serve a route
from.

---

## Session — Logo/wordmark spacing, and why the wordmark stays neutral

Gap tightened two ways rather than one: the flex gap 9px → 7px, plus a `-2px` left margin on the
wordmark. Mono tracking adds a leading sidebearing on the first glyph, which reads as extra space
after the mark — shrinking the flex gap alone would have under-spaced a non-mono wordmark later.
Wordmark also sized up 0.875 → 0.9375rem to sit better against the 30px mark.

### Blue wordmark — recommended against, not yet decided

The user asked whether the wordmark should also be blue. Recommended no, on two grounds:

1. **The accent budget.** `ui.md` §2.4 spends accent on the primary action, focus, the current nav
   item and links — nothing else. A blue wordmark is a permanent accent block in the top-left of
   every page, competing with the focus ring and primary button for the attention those need.
2. **`accent` differs per theme** (`#0049FD` light, `#4D7FFF` dark). A _mark_ shifting slightly
   lighter on dark reads as correct; a _word_ shifting shade reads as inconsistent, because text
   is where colour drift is noticed.

If overridden, the wordmark should use the mark's own `#0049FD` fixed in both themes rather than
the `accent` token, so it does not shift between light and dark. Recorded rather than applied —
it is a brand call, not a system one.

---

## Session — Five Foundations pages added; mark sized up again

Design system now **33 routes**, up from 28. Mark 30px → 36px.

### What Geist has that this did not

Compared against Geist's structure rather than guessed. Its Foundations covers colours,
typography, materials, grid and assets; ours had colours, typography, space, depth, motion and
layers. Five genuine gaps, all now filled:

**Brand** — the newly-real page. Three colour variants on their intended backgrounds, clearspace
(minimum = the mark's own height, shown on a grid at exactly that unit), the lockup with its
measurements, and a do/don't pair. It also records that the mark is not the product name: the
protocol is `x402`, Spigot is built on it and never named after it.

**Grid** — 12 columns on a 4px base, with the reason stated: 12 divides by 2, 3, 4 and 6, so
halves, thirds, quarters and sixths all land on the grid. 10 or 16 do not. Container widths use
`68ch` for reading copy rather than a pixel value, because a measure holds across type sizes.

**Icons** — the gap flagged several sessions ago. Twelve core Lucide icons rendered, one stroke
weight, four sizes mapped to context. The rule that matters: mixing icon sets is the fastest way
to make an interface look assembled rather than designed, because differing stroke weights read
as inconsistency even when nobody can name why.

**Accessibility** — consolidation, not new rules. Every constraint on this page already shapes a
token or component elsewhere; stating them together is what makes them checkable. Contrast
targets, focus-vs-selection, colour never alone, reduced motion, touch targets, native elements,
genuine `disabled`, tooltips on focus.

**Content** — the vocabulary ban, the substitution table, voice rules and the prohibitions, now
inside the design system rather than only in `product-marketing.md`. Copy is part of the system:
a component with improvised words is as inconsistent as one with improvised colour.

### Method note

The earlier destructive edit made bounded replacement the rule. Every page here was injected at
a single matched anchor and verified afterwards by route-list cross-check, tag balance and CSS
rule count (307). One reported desync was a false positive — the HTML route regex omitted the
hyphen that `spec-row` contains — confirmed by re-running with matching patterns rather than
assumed benign.

### Still not done

Component pages remain shallow against Geist: Button has 3 sections where Geist's has 11 (Sizes,
comparison, Shapes, Prefix/suffix, Rounded, Loading, Disabled, Disabled variants, Link, Custom,
Best Practices). That is roughly 15–20 sections across 28 component pages and is the largest
remaining piece of work.

---

## Session — Wordmark unified and bolded

`Spigot` + a muted `Design System` label became a single `Spigot Design System` string at mono
700, and the mark grew 30px → 36px.

Worth recording because it removed a rule rather than adding one: the split version needed a
`display: none` at 1240px to stop the label wrapping onto a second line. **One string at one
weight cannot wrap apart from itself**, so that breakpoint rule and its `.brandbox .sub`
declaration are both gone. CSS went 307 → 305 rules while gaining capability.

A verification note: an automated check reported `class="sub"` still present after the removal.
It was a false positive — `h4.sub` is the section-subheading class used throughout the page, a
different thing from the deleted `.brandbox .sub`. Confirmed by inspecting the brandbox markup
directly rather than trusting the string match.

---

## Session — Working rule: build what is asked, not what might be needed

The user set an explicit constraint: **do not add sections, parts or pages before they are asked
for.** They decide where each piece goes as the product is built and will say so at the time.

This directly cancels a proposal made moments earlier — expanding all 28 component pages to match
Geist's section depth (Button alone would have gained eight sections). That was framed as closing
a gap; under this rule it is speculative structure.

The reasoning holds up. Geist's Button page has eleven sections because Vercel needed eleven, not
because eleven is correct. Copying a structure section-for-section imports another product's
requirements. Speculative structure also **looks like thoroughness and behaves like debt** — it
has to be reviewed, maintained and kept truthful, and most of it is never used.

Recorded in two places so it survives this session and applies to any agent:

- `AGENTS.md` §4a — the repo entry point every agent reads first
- `.agents/skills/x402-design` §5a — the Layer 0 skill for frontend work

The operative instruction in both: **if something looks missing, name it and stop.** Naming a gap
costs a sentence; filling it uninvited costs a review and often a revert.

---

## Session — Number-column gap, font naming, and a stale Layer 0 skill

### The `.num` fix from an earlier session was too broad

Right-aligned numbers were touching the column beside them — `0Page content`, `640pxSpec rows`.
Caused by `padding-right: 0` on `.num` globally, added when aligning the table's right edge. The
intent was only ever the **last** cell; applying it to every numeric cell removed the gap between
that column and the next.

Now `padding-right: 0` is scoped to `:last-child` alone, with the reason recorded inline so the
next person does not re-broaden it.

### Removing the font switcher removed the font's name

The Typography page told users to consult a switcher that no longer exists — nowhere on the page
said what the typeface actually was. Replaced with a table naming both faces, their weights and
italic availability, plus the note that both are self-hosted at build time.

Worth recording as a class of error: **deleting a control can orphan the copy that referred to
it.** The switcher's removal was correct; the sentence pointing at it became a dead reference in
the same commit.

### The Layer 0 skill had gone badly stale

`.agents/skills/x402-design` still described the state before the design system existed: Inter as
the font, white/black as the accent, nine tokens, and the original "known gaps" listing 35 raw
palette usages as outstanding work. All of that is resolved, and an agent reading it would have
been actively misled — the exact opposite of what a Layer 0 file is for.

Rewritten to defer: **`ui.md` is the authority on tokens**, and the skill now carries only what
is genuinely Layer 0 — the things that fail silently — plus a token _group_ summary for
orientation. Baseline corrected to 61 warnings and 40 checks, and the raw-palette grep added to
its verification block.

That staleness is a structural risk, not a one-off: two files describing the same tokens will
always drift. Pointing one at the other is the fix.

---

## Session — Topbar: clipped wordmark, compartment rules, unboxed theme control

### The wordmark was clipped by an earlier change

`Spigot Design System` rendered as `Spigot Design Syste`. The brand block is fixed to
`--sidebar` width with `overflow: hidden`, and an earlier responsive pass narrowed the sidebar
268px → 240px. At 240 the block had 169px of usable space for a string needing ~180px.

Fixed by measurement rather than by nudging: sidebar restored to 268px, mark 36 → 30px, wordmark
15 → 14px with tracking eased 0.04 → 0.02em. That leaves ~203px for a ~174px string — roughly
29px of headroom, so a longer name would not immediately re-clip.

Worth noting the failure mode: `overflow: hidden` on the brand block was added deliberately, to
stop the label wrapping onto two lines. It did that — and then silently truncated instead. **A
container that cannot wrap will clip**, and clipping is quieter than wrapping.

### Compartment rules

The brand block already had a right border. Added a matching full-height rule before the theme
control, so the bar reads as three compartments — brand, content, controls — rather than one
strip with items floating in it. `align-self: stretch` makes it span the bar's height rather
than the button's.

### Theme control unboxed and animated

Border and hover background removed; it is now a bare icon that changes colour on hover. A
bordered box implied a button among other buttons, when it is the only persistent control there.

The sun and moon are **both rendered, stacked in the same grid cell**. Switching themes rotates
and scales the outgoing icon away while the incoming one rotates in, rather than swapping
`display: none`. That makes it a transition instead of a pop, and it means the layout never
reflows because both glyphs always occupy the cell.

`prefers-reduced-motion` drops the transition to 0.01ms — the icon still changes, it just
arrives instantly, consistent with §4.4.

**On `lucide-animated` specifically:** it installs per-icon React components through the shadcn
CLI and depends on Motion. The docs site is a standalone HTML file with no build step, so the
package cannot be used there. The animation above uses Lucide's own sun and moon paths driven by
CSS, which matches the family and needs no dependency. In the app — which does have a build step
— `lucide-animated` remains available, subject to the §6.4 caveat that its CLI expects a
`components.json` this repo does not yet have.

---

## Session — Topbar matched to the Geist reference

Three structural changes, taken from the supplied screenshot rather than inferred.

**Wordmark is sans, not mono.** Geist sets its name in the sans face at semibold; ours was mono
700, which read as a code label rather than a product name. Mono remains correct for the label,
ID and numeral roles — a product name is none of those.

**Theme is a segmented pair, not a toggle.** Two buttons in a pill — sun and moon — with the
active one filled. A toggle only tells you what pressing it _will_ do; a segmented pair tells you
which theme is _currently on_, which is the more useful fact.

The active state is driven by `[data-theme='light'] .i-light` rather than a JavaScript class, so
it reads directly from the page's actual theme and **cannot disagree with it**. `tog()` became
`setTheme(n)` — an explicit value instead of an inversion, which is also what makes a third
option (system) cheap to add later, if ever asked for.

**Breadcrumb removed from the bar.** Geist has none, and it duplicated the page title sitting
directly below it. The standalone divider added in the previous session went with it — the
segmented pill supplies its own boundary, so a separate rule was redundant.

### The cross-check earned its place

Removing the breadcrumb element left `document.getElementById('crumb').innerHTML` in `app.js`.
That would have thrown on **every route change**, breaking navigation entirely — and the page
looks perfectly fine until you click something.

The element-id cross-check reported `missing ids: [ 'crumb' ]` immediately. This is the second
time this session that a check has caught a real break that visual inspection would not, and it
is the direct payoff from adding those checks after the CSS deletion incident.

---

## Session 12 — Multi-Chain EVM Support (Ethereum, Base, Arbitrum, Optimism, Avalanche, Robinhood)

### Decision 46 — Multi-chain routing via CAIP-2 prefixes, retaining chain-agnostic credit ledger

The platform was originally built exclusively on Algorand. To support EVM chains requested by
users (Ethereum, Base, Arbitrum, Optimism, Avalanche, Robinhood), the x402 v2 protocol's CAIP-2
network identifiers are used to route requests dynamically across chain families without
breaking backwards compatibility with existing Algorand infrastructure.

**Key Architecture Decisions:**

1. **Chain Registry (`services/chains.ts`):** Central source of truth mapping CAIP-2 strings
   (`algorand:*`, `eip155:*`) to token contracts, explorer URLs, RPC endpoints, and chain families.
2. **Multi-Chain 402 Challenge:** The gateway challenge returns `accepts[]` containing payment
   requirements for all enabled chains, allowing callers to pay via any supported network.
3. **Facilitator Routing:** Verification and settlement route based on the network prefix:
   `algorand:*` routes to GoPlausible (`FACILITATOR_URL`), `eip155:*` routes to the EVM facilitator
   (`EVM_FACILITATOR_URL` / `https://facilitator.x402.rs`).
4. **EVM Custody Payment:** Uses `@x402/evm` `ExactEvmScheme` to sign EIP-3009 gasless
   `transferWithAuthorization` payloads from a platform settlement private key.
5. **Chain-Agnostic Credits:** Unspent user credits remain 1 credit = 1 USDC (6 decimals)
   regardless of settlement chain.
6. **Publisher Onboarding:** Publishers can select any supported chain and provide a matching
   Algorand or EVM (`0x...`) payout address.

### Decision 47 — Multi-chain user custodial wallets and testnet contract addresses

Users signing in now automatically receive both an Algorand custodial wallet and an EVM custodial
wallet (`viem` generated secp256k1 keypair, encrypted at rest via AES-256-GCM in `custodial_wallets`).

1. **Testnet Token Addresses:** Updated all EVM networks to official Circle testnet USDC contract
   addresses:
   - Ethereum Sepolia: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (`eip155:11155111`)
   - Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (`eip155:84532`)
   - Arbitrum Sepolia: `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (`eip155:421614`)
   - Optimism Sepolia: `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` (`eip155:11155420`)
   - Avalanche Fuji: `0x5425890298aed601595a70AB815c96711a31Bc65` (`eip155:43113`)
   - Robinhood Testnet: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (`eip155:46630`)
2. **EVM Treasury Address:** Set `EVM_SETTLEMENT_ADDRESS=0x1ad87A1B6bae98d2Ef1f93f5fA4B4105E34f3477`.
3. **Multi-Chain Funding & Profile:**
   - `GET /credits` and `GET /auth/me` return both Algorand and EVM addresses.
   - `TopUpPanel` offers tabbed funding modes for Algorand wallet, EVM testnet deposit (with Circle faucet instructions), and Razorpay checkout.
   - `Profile.tsx` displays both custodial wallets with 1-click address copy and block explorer links.

---

## Session 13 — Multi-Chain Solana (SVM) Support

### Decision 48 — Solana (SVM) chain family integration

Added Solana as a first-class supported chain family alongside Algorand and EVM, following the established multi-chain architecture.

**Key Architecture Decisions:**

1. **Chain Family Extension (`services/chains.ts`):** `ChainFamily` widened to `'algorand' | 'evm' | 'solana'`. Registered Solana Devnet with CAIP-2 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, and devnet cluster explorer URLs.
2. **Solana Custodial Wallets (`services/wallet.ts`):** Users receive an ed25519 Solana `Keypair` generated via `@solana/web3.js`, encrypted with AES-256-GCM in `custodial_wallets`.
3. **x402 SVM Payment Scheme (`services/payment.ts`):** Uses `@x402/svm`'s `ExactSvmScheme` to build and sign Solana payments with token program transfer instructions.
4. **Facilitator & Treasury Routing:**
   - `services/facilitator.ts`: Routes `solana:*` network requests to `SOLANA_FACILITATOR_URL` (`facilitator.x402.rs`).
   - `services/treasury.ts`: Added `sendSolanaUsdc()` and `getSolanaTreasuryAddress()` using `@solana/spl-token` and `@solana/web3.js` for SPL token transfers.
   - `services/settlement.ts`: Payouts for publishers with Solana wallets route through `sendSolanaUsdc()`.
5. **Universal Consumer & Pricing UI:**
   - `ConsumerTest.tsx` allows executing monetized API calls using Solana as the settlement network.
   - `Pricing.tsx` allows publishers to select Solana and input their Base58 payout address.
   - `Profile.tsx` displays the user's dedicated Solana custodial wallet with 1-click copy and Solana Explorer link.
   - `TopUpPanel.tsx` offers dedicated Solana wallet tab, Phantom/Solflare wallet connection, and Solana Devnet target network option for instant treasury provisioning.
   - Configured `SOLANA_SETTLEMENT_ADDRESS=EUVE7j6FBfZxq5yYSUVi24wE6iQcbbuHZ1jNwrFGbatw` as the platform Solana treasury address.

---

## Session 14 — Payment Verification Hardening

### Decision 49 — Authoritative Facilitator Verdict in `verifyPayment()`

**Problem:** In `backend/src/services/facilitator.ts`, `verifyPayment()` checked `if (res && res.isValid) { return res; }`. When the remote facilitator answered with an explicit rejection (`{ isValid: false, invalidReason: ... }`), the check evaluated to false, skipped the block, and fell through to returning `{ isValid: true }`. Furthermore, the offline EVM fallback returned `{ isValid: true }` even when `verifyTypedData` returned false or threw.

**Fix:**

1. Authoritative verdict return: If the facilitator answered with `typeof res.isValid === 'boolean'`, return `res` directly (propagating `isValid: false` and `invalidReason` to `gateway.ts` and `credits.ts`).
2. Scoped offline fallback: Only when the facilitator is unreachable (in `catch` / fallback) do chain-specific offline validations execute.
3. Strict offline EVM & SVM validation: If local `verifyTypedData` fails or the payload is malformed, return `{ isValid: false, invalidReason: ... }` with reasons, preventing bypass on invalid signatures.

### Decision 50 — Accurate Failure Propagation in `settlePayment()`

**Problem:** When EVM settlement failed (facilitator unreachable and direct node broadcast failed), `settlePayment()` fabricated a fake transaction ID using the client-supplied payload nonce or a timestamp (`0x...`) and returned `{ success: true }`. Similarly, Solana returned a synthetic `sol_...` ID with `{ success: true }` if broadcast failed. This caused `credits.ts` and `gateway.ts` to treat failed payments as settled and allowed client-controlled idempotency keys.

**Fix:**

1. Both EVM and Solana branches in `settlePayment()` now return `{ success: false, network, errorReason }` when broadcast fails or no valid on-chain transaction was submitted/confirmed.
2. Verified that all chain branches (Algorand, EVM, Solana) only return `{ success: true }` when backed by a real on-chain transaction hash.

---

## Session — Network profiles extended to EVM and Solana, and a mainnet boot guard

Backend and config session. The ask was env and config files that make testnet/mainnet
switching easy. Algorand already had `ALGORAND_NETWORK_PROFILE`; EVM and Solana did not.

### Decision — the profile drives every chain family, not just Algorand

`chains.ts` had one hardcoded table, entirely testnet: Sepolia, Base Sepolia, Arbitrum
Sepolia, Optimism Sepolia, Fuji, Robinhood testnet, Solana devnet. `ALGORAND_NETWORK_PROFILE=mainnet`
moved Algorand and left all of them on testnet, silently. `EVM_CHAINS_BY_PROFILE` and
`SOLANA_CHAINS_BY_PROFILE` are now keyed by the same profile, so one switch moves everything.

### Decision — `robinhood` is excluded from mainnet rather than guessed

The other five EVM chains use canonical Circle USDC deployments, which are well known and
stable. Robinhood chain's mainnet id, USDC address and RPC could not be verified. The options
were to guess, or to leave it out.

Guessed right, nobody notices. Guessed wrong, mainnet payments go to a contract nobody owns
and the money is gone. So it is absent from the mainnet table and from the mainnet
`EVM_ENABLED_CHAINS` default, and `EVM_CHAIN_OVERRIDES_JSON` exists as the way to supply real
values. An enabled chain with no definition now throws at boot instead of being skipped:
skipping leaves it enabled in config but missing at runtime, so the failure surfaces during a
payment, far from the cause.

### Decision — fail at boot, not mid-payment

The likeliest way to get hurt is not the profile, it is a `.env` carrying leftover testnet
overrides. Confirmed while testing: with the repo's own `.env` present, `ALGORAND_NETWORK_PROFILE=mainnet`
still resolved the testnet CAIP-2 and testnet ASA, because both were individually overridden.

So mainnet now asserts at import: treasury mnemonics present, no domain-verify bypass, ASA is
31566704, CAIP-2 is the mainnet one, and no algod, explorer or Solana RPC still containing
`testnet` or `devnet`. All problems are reported together, then it exits.

### Decision — `.env.testnet.example`, not `.env.testnet`

First draft named them `backend/.env.testnet` and `backend/.env.mainnet`. Security check S1.2
rejects any tracked `.env.*` that is not `.example`, and it is right to: an un-ignored file
called `.env.mainnet` is where somebody eventually pastes a real mnemonic. Renamed before
committing.

### Frontend explorer links moved server-side

`Profile.tsx` and `TopUpPanel.tsx` hardcoded `sepolia.etherscan.io`,
`testnet.explorer.perawallet.app` and `sepolia.basescan.org`. Those survive a mainnet switch
untouched and quietly link to the wrong network. The credits overview now returns
`explorerUrls`, built by `getExplorerAddressUrl()` from the active profile, and the frontend
renders whatever it is given.

---

## Session — Product renamed to Spigot, and the npm name that was not available

### Decision — three categories, not two

The obvious framing was "product name vs protocol". That is not enough. A third category
exists and is where the risk actually sits: **identifiers that read like the product name but
are live state**. Renaming those breaks running systems for no branding gain.

| Category        | Action | Examples                                                                                                         |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Product name    | Rename | `MERCHANT_NAME`, `EMAIL_FROM`, email subjects, package names, README title, `openapi.yaml` title                 |
| Protocol        | Leave  | `x402Version`, `/x402/*` routes, `PAYMENT-SIGNATURE`, `@x402/avm`, `X402_CHALLENGE_TAG`, `x402-global-challenge` |
| Live identifier | Leave  | `x402_session` cookie, `x402_api_key`, `x402_publisher_id`, `x402_theme`, `DATABASE_PATH=.../x402.db`, `~/.x402` |

Renaming the cookie logs out every live session. Renaming `x402.db` orphans the mounted
Railway volume and the ledger with it. Neither is user-visible branding, so neither moved.

### Decision — the CLI package is `spigot.sh`, not `spigot`

`npx spigot` cannot work. The bare npm name is taken by an unrelated package published in
2012-2013 (`spigot@0.0.3`, maintainer `regality`, "process jobs at a certain concurrency
rate"). It still serves ~96 downloads a month and its repo is live, so it is a real package,
not a squat. npm's dispute process protects an incumbent with genuine content and non-zero
usage, which makes a transfer a request to a stranger rather than a procedure.

`spigot-cli` was the obvious fallback and is also taken (v1.0.0).

`spigot.sh` is free, and a dotted package name is ordinary npm (`socket.io`, `lodash.merge`).
It also makes the install line and the domain the same string.

Verified rather than assumed, by packing a fixture and running it:

- `npx spigot.sh` resolves and executes, both with a single bin whose name differs from the
  package and with two bins where one matches
- installing declares **both** `spigot` and `spigot.sh` on `PATH`

So the **typed** command is `spigot` and only the `npx` form carries the suffix. Copy must say
`npx spigot.sh`. Anyone "correcting" that to `npx spigot` is pointing users at a stranger's
2013 job queue.

Recorded in `.agents/product-marketing.md` §8 so it is not relitigated.

### Rejected — renaming `~/.x402`, `x402.db` and the session cookie

Consistency argument: a CLI called `spigot` storing credentials in `~/.x402` looks unfinished.
Rejected for now because it is invisible to users and the cost is real state loss. Worth doing
in a deliberate migration, not folded into a rename commit.

### Left alone — `MERCHANT_WEBSITE` default

Both defaults still point at `https://x402-algorand.onrender.com`, which is the old name _and_
a dead host now that deploy is Railway. It is a URL rather than a name, so it was out of this
commit's boundary, but it is wrong on two counts and needs its own fix.

### Note — the repo name stays `x402-algorand`

Deliberate. The GitHub remote, the clone URL in `README.md` and the Railway project name are
unchanged. Only the product is Spigot.

---

## Session — `no-explicit-any` to zero, and the rule flipped to `error`

### Decision — type rows at the query, not at the call site

Every backend `any` was the same shape: `db.prepare(...).get(...) as any`. There was no typed
query anywhere in the repo, so the first job was picking a pattern.

`@types/better-sqlite3` already supports `prepare<BindParameters, Result>`, so
`.get()` returns `Result | undefined` with **no cast at all**. That beats casting the result,
because the type sits next to the SQL that produces it and the `undefined` case stops being
invisible.

Typing the `undefined` immediately found two places that had been ignoring it:

- `getUptimeStats` read `total.count` on a row that could be absent
- the publish precondition read `endpoints.c` the same way

Both now handle it. Neither was reachable in practice — `COUNT(*)` always returns a row — but
the old code could not express that and the new code does not have to.

### Decision — `unknown` plus a narrowing check, never `unknown` then a cast back

The brief was explicit that swapping `any` for `unknown` and casting straight back is not a
fix. Where a value is genuinely open — a thrown error, a parsed JSON envelope — it is `unknown`
and gets a real runtime check before use.

One cast is deliberately kept: `return body as T` in the two generic fetch wrappers
(`frontend/src/api/auth.ts`, `frontend/src/api/credits.ts`). A generic deserialiser cannot
prove the server sent `T` without runtime schema validation. The honest options are to keep
one narrow cast or to add a validator to every endpoint; the second is a much larger change
than a lint pass, so it is recorded here rather than smuggled in. Everything _around_ that
cast is now checked.

### Two defects the types found

Both were latent, both were hidden by the `any` that was there to keep the count down.

- `ApiTesting.tsx` branched on `res.success`. `POST /apis/:id/test` returns a health-check
  row, which has no `success` field, so `status !== 'OFFLINE' || res.success === true` could
  never take its second branch. Reduced to the equivalent expression.
- `client.ts` declared `authType: 'None'` while the backend writes `'NONE'`.
  `OnboardingData` already carried both spellings with a comment explaining the legacy value;
  `client.ts` had drifted from it. Widened to match rather than narrowed, because the backend
  uppercases before validating and both spellings genuinely work.

### Removed — the algosdk v2 asset-id fallback

`wallet.ts` read `a.assetId ?? a['asset-id']`, covering algosdk v2's kebab-case keys. The
package is pinned `^3.2.0` and resolves to 3.6.0, where `.do()` is typed and the kebab form
cannot occur. The `any` was the only thing letting the dead branch compile. Dropped with it.

### Decision — flip to `error`, and why the comment had to change too

`eslint.config.mjs` justified `warn` on the grounds that API and wallet boundaries have
genuinely unknown upstream shapes. That was true, and it is now handled by `unknown` plus
narrowing rather than by `any`.

A warning does not hold a count at zero. It drifts, which is exactly how this reached 58. The
rule is `error`, and the rationale comment was rewritten rather than left contradicting the
setting.

### Baselines corrected in four places

The numbers were stale in more places than the brief listed. `AGENTS.md` §5 and `verify.md`
were the two known ones. Also found: `taste.md` §0 and `.claude/skills/x402-router/SKILL.md`
both still read `63 warnings, 39/39 security` — the figures AGENTS.md itself records as wrong.
All four now read 0 warnings, 40/40, and the router skill defers to AGENTS.md explicitly so
the next drift resolves instead of propagating.

`verify.md`'s "Known debt" table was also internally inconsistent: it claimed 59 `any` and 2
`exhaustive-deps` while its own gate text said 1. Both rows now read 0.

---

## Session — Multi-Chain Stellar Integration (Soroban / ExactStellarScheme)

### Decision 51 — Stellar Integration with Native 7-Decimal USDC & Sponsored Fees

**Context:** Added first-class Stellar support alongside Algorand, EVM, and Solana across the entire stack.

**Key Technical Decisions:**

1. **Protocol Implementation:** Integrated `@x402/stellar` (`ExactStellarScheme`, `createEd25519Signer`) and `@stellar/stellar-sdk` with CAIP-2 `stellar:testnet` / `stellar:pubnet`.
2. **Decimal Handling:** Stellar USDC uses 7 decimals (1 USDC = 10,000,000 stroops). Handled dynamic decimal exponentiation (`10 ** chain.usdcDecimals`) in requirements generation, payments, and top-ups rather than hardcoding 6 decimals.
3. **Fee Sponsorship:** Configured `extra.areFeesSponsored = true` for gasless caller execution where facilitator / treasury sponsors transactions.
4. **Custodial Wallets:** Keypairs generated via `Keypair.random()`, public address `G...` stored in `custodial_wallets`, secret `S...` encrypted with AES-256-GCM.
5. **Settlement & Payouts:** Added `sendStellarUsdc()` for publisher payouts and balance inspection via Stellar Horizon and Soroban RPC.
6. **Frontend Experience:** Added Stellar to chain selectors in consumer test view, onboarding pricing configuration with `G...` 56-character regex validation, profile custodial wallet cards, and TopUpPanel tabs.

### Decision 52 — Fallback Verification & Direct Account Provisioning on Stellar

**Problem:** Public EVM/SVM facilitators reject `stellar:*` network payloads with `unsupported_scheme`. Furthermore, newly created Stellar addresses cannot receive asset payments without existing accounts and trustlines on Horizon.

**Fix:**

1. In `verifyPayment()`, bypass remote facilitator when it reports `unsupported_scheme` or `unsupported_network`, routing to chain-native validation.
2. In `settlePayment()`, if raw XDR is not present, fall back to `sendStellarUsdc(payTo, amount)`.
3. In `sendStellarUsdc()`, check if destination account exists on Horizon. If absent, provision with `Operation.createAccount`; if trustline is absent, transfer native asset or establish trustline.

---

## Session — Monorepo Decomposition: Extract Frontend to `spigot-website`

### Decision 53 — Separate Frontend Application from Platform Backend & CLI

**Context:** The monorepo previously combined the Express backend, publisher CLI, and Next.js frontend into a single repository. The user requested keeping only the backend and its related folders here and moving the frontend and its related folders to a separate folder outside this directory called `spigot-website`.

**Key Actions & Architecture:**

1. **Standalone Frontend (`spigot-website`):**
   - Moved `frontend/src`, `frontend/public`, Next.js and Tailwind configs (`next.config.ts`, `postcss.config.mjs`, `tsconfig.json`, `railway.toml`, `.env.example`) to `../spigot-website`.
   - Moved UI design system documentation (`ui.md`, `taste.md`, `geist-notes.md`, `designsystem-plan.md`, `designsystem-gap.md`) and generator script (`scripts/gen-designsystem-llm.mjs`) to `spigot-website`.
   - Provided standalone `package.json`, `eslint.config.mjs`, `.gitignore`, `.prettierrc.json`, and `README.md` for independent frontend development and deployment.
   - Frontend continues to proxy `/api` and `/x402` requests to the backend origin via `BACKEND_ORIGIN`.

2. **Streamlined Backend & CLI (`spigot-arc`):**
   - Removed `frontend/` directory and frontend-specific design system markdown docs and scripts.
   - Updated root `package.json` workspaces to `["backend", "cli"]`, targeting scripts strictly at backend and CLI.
   - Cleaned root `eslint.config.mjs` to remove Next.js plugins and React-specific rules, focusing purely on TypeScript and Node environments.
   - Updated `scripts/security-review.sh` to remove frontend bundle and JSX checks, adjusting active backend security gates to 33 checks (all passing).
   - Updated CI workflow (`.github/workflows/ci.yml`) to remove the frontend build job.
   - Updated `AGENTS.md`, `flow.md`, `env.md`, and `verify.md` to reflect the backend-only scope.

---

## Session — Arc Testnet Migration and Nanopayments

### Decision 54 — Make Arc Testnet Default Primary L1 with Native USDC Gas and Nanopayments

**Context:** Replaced Algorand as the primary default network with Arc Testnet (`chainId: 5042002`, `caip2: 'eip155:5042002'`), while introducing EIP-3009 TransferWithAuthorization nanopayments for micro-metered API calls.

**Key Technical Decisions:**

1. **Arc L1 Architecture:**
   - Arc is Circle's L1 EVM blockchain featuring native USDC for gas. No ALGO or ETH is required for gas fees.
   - Canonical USDC address: `0x3600000000000000000000000000000000000000` (6 decimals).
   - RPC: `https://rpc.testnet.arc.network`, Explorer: `https://testnet.arcscan.app`.
   - 0-opt-in accounts: standard EVM addresses (`0x...`) receive and hold USDC immediately without ASA opt-ins or account creation fees.

2. **Nanopayments via EIP-3009 TransferWithAuthorization:**
   - Standard x402 payment requirements generate EIP-712 typed authorizations (`transferWithAuthorization`).
   - Consumers or custodial wallets sign authorizations off-chain using standard `viem` `signTypedData`.
   - Created `services/nanopayments.ts` which verifies authorizations with cryptographic replay protection using unique nonces.
   - Nanopayments are tracked in the database under `nanopayments` table and aggregate into `nanopayment_batches` for on-chain settlement, saving substantial gas and enabling instant sub-cent transactions.

3. **Custodial Wallets & Multi-Chain Treasury:**
   - Users automatically receive EVM/Arc custodial wallets (`chain = 'arc-testnet'`) upon signup.
   - 3-account treasury model adapted to Arc: `ARC_TREASURY_PRIVATE_KEY` (operations), `ARC_SETTLEMENT_PRIVATE_KEY` (revenue), and `ARC_CUSTODY_PRIVATE_KEY` (credit backing).
   - Direct USDC transfers via `sendArcUsdc()` using `viem` wallet clients with native gas estimation.

4. **Preserved Multi-Chain Backends:**
   - Algorand, Solana, Stellar, and other EVM chains remain supported as secondary networks through unified routing in `services/payment.ts` and `services/chains.ts`.

---

## Session — Complete Removal of x402 Dependencies and Replacement with Nanopayment Protocol

### Decision 55 — Replace x402 Protocol and Dependencies with Native Nanopayments

**Context:** The user requested replacing x402 with nanopayments and removing x402 entirely if still being used.

**Key Technical Decisions & Actions:**

1. **Eliminated `@x402/*` External Dependencies:**
   - Completely uninstalled all `@x402/*` packages (`@x402/avm`, `@x402/core`, `@x402/evm`, `@x402/extensions`, `@x402/stellar`, `@x402/svm`) from `backend/package.json`.
   - Replaced all protocol helpers with a native, zero-dependency `nanopaymentProtocol.ts` implementation:
     - `buildChallenge`: Generates RFC-compliant 402 challenge payloads containing both `nanopaymentVersion: 1` and `x402Version: 2` specification headers.
     - `decodePaymentPayload`: Decodes Base64-encoded payment payloads with validation against replay and malformed inputs.
     - `buildExtensions`: Native builder for discovery and payment schemes without external library dependencies.
   - Converted `backend/src/services/x402.ts` into a backward-compatibility re-export module over `nanopaymentProtocol.ts`.

2. **Native Payment Signing & Facilitator Layer:**
   - In `backend/src/services/payment.ts`, replaced all `@x402/*` signing wrappers:
     - EVM/Arc: Pure `viem` EIP-712 typed signing via `services/nanopayments.ts`.
     - Algorand: Native `algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject` and `algosdk.decodeSignedTransaction`.
     - Solana: Native `@solana/web3.js` `Transaction` construction and serialization.
   - Removed dynamic loader wrappers (`loadAvm`, `loadEvm`, `loadSvm`, `loadViemAccounts`) entirely.

3. **Gateway Routing & Headers:**
   - Mounted first-class nanopayment endpoints alongside backwards-compatible aliases:
     - Routes: `/nanopay`, `/api/nanopay`, `/pay`, `/api/pay`, `/x402`, `/api/x402`.
     - Headers: Emits `NANOPAYMENT-REQUIRED`, `NANOPAYMENT-RESPONSE`, `NANOPAYMENT-SIGNATURE` in addition to HTTP 402 standard headers.
     - Discovery: Exposed `/.well-known/nanopayments.json` and `/api/.well-known/nanopayments.json`.
     - Raw body parsing in `index.ts` updated for `/nanopay/*`, `/pay/*`, `/x402/*`.
     - Proxy service header filter updated to strip `nanopayment-*` headers before forwarding upstream.

4. **Session & Security Integrity:**
   - Updated session cookie default to `spigot_session` with backward-compatible recognition of legacy `x402_session`.
   - Health check probe user-agent updated to `Spigot-Nanopayment-Probe/1.0`.
   - Verification DNS TXT record format defaults to `spigot-verification=<token>` (with backward compatibility for `x402-verification=`).
   - CLI config updated to `.spigot/` directory with automatic fallback to `.x402/`.
   - Maintained 0 lint errors, 0 warnings, clean typechecks, and 33/33 security checks passed.
