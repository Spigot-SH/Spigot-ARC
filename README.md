# Spigot

[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-black.svg)](LICENSE)
[![Arc Testnet](<https://img.shields.io/badge/Arc%20Network-Testnet%20(5042002)-black.svg>)](https://rpc.testnet.arc.network)
[![Nanopayments](https://img.shields.io/badge/Nanopayments-EIP--3009-black.svg)](#nanopayments)
[![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1-black.svg)](./openapi.yaml)

**Sell your API by the call. Get paid in USDC on Arc Testnet with Nanopayments. Nobody touches a wallet.**

List any HTTP endpoint, set a price, and the gateway puts a nanopayment paywall in front of it.
Callers buy credit once and then just call — every request settles via **EIP-3009 off-chain signed Nanopayments**
on **Arc Testnet** with native USDC gas, with no popups, no seed phrases, and zero transaction friction.
Secondary multi-chain support is also built-in for Solana, Stellar, and standard EVM chains.

```bash
npx spigot.sh init --openapi openapi.yaml   # read your endpoints
npx spigot.sh publish                       # live, priced, discoverable
```

---

## Why this exists

Metered APIs normally mean signups, invoices, minimums and a payment processor. x402 replaces
that with an HTTP status code: request a resource, get `402 Payment Required`, attach a
payment, get your data.

The problem is that raw x402 asks the _caller_ to hold a wallet, hold gas, and approve a
transaction for every request. That is fine for an agent with a funded key and hopeless for
everyone else.

This gateway removes all of it:

|                               | Raw x402      | This gateway                                  |
| ----------------------------- | ------------- | --------------------------------------------- |
| Caller needs a wallet         | Every request | Once, to buy credit                           |
| Caller needs gas tokens       | Yes           | Never — Nanopayments & facilitator pay gas    |
| Publisher writes payment code | Yes           | None. Hand over a plain URL                   |
| Per-call approval             | Yes           | None                                          |
| On-chain settlement           | Yes           | **Yes — still one real transaction per call** |

Nothing is faked to achieve that. Every call is an actual USDC transfer you can look up on
an explorer.

---

## How a call works

```
Caller ──1──► Gateway ──2──► Facilitator ──3──► Arc Network
                 │                                  │
                 │◄─────────── settled txid ────────┘
                 4
                 ▼
            Publisher's API ──► response ──► Caller
```

1. Caller spends credit — one authenticated request, no wallet
2. Gateway builds a gasless payment group and asks the facilitator to verify it
3. Settle on Arc Network via EIP-3009 Nanopayments or gasless facilitator
4. Only once the payment is settled does the gateway call the publisher's API

Settlement happens **before** the upstream call, so a broken upstream can never be served
for free — and if the upstream fails, the caller's credit is refunded.

---

## Quick start

```bash
git clone https://github.com/0xSarnavo/spigot-arc.git
cd spigot-arc
npm install
cp backend/.env.example backend/.env
npm run dev
```

Frontend on `http://localhost:5173`, API on `http://localhost:4402`.

It runs with **no configuration**: session and encryption secrets are generated on first
boot, and sign-in codes print to the server console when no email provider is set. To take
payments you need three Arc accounts — see [mainnet.md](./mainnet.md).

---

## For API publishers

Give the gateway a **plain HTTP endpoint** and a price. Your service needs no payment code,
no SDK, no middleware. It must _not_ already be x402-protected — the gateway is the paywall,
and fronting a paid endpoint would charge your callers twice.

Describe your API in `spigot.yaml`, committed next to your code:

```yaml
name: Weather Intelligence API
baseUrl: https://api.example.com
pricePerRequest: 0.01
payoutAddress: YOUR_ARC_ADDRESS
endpoints:
  - name: Current conditions
    method: GET
    path: /forecast
    description: 'Temperature, humidity, conditions and a 3-day forecast for a city'
```

```bash
npx spigot.sh login      # emailed code, no password
npx spigot.sh publish    # register, price, verify the endpoint, go live
npx spigot.sh status     # traffic and revenue
npx spigot.sh settle     # send earnings to your own wallet
```

`spigot init --openapi spec.yaml` writes the manifest for you, including descriptions and
response examples — which is exactly what the Bazaar catalog shows to humans and agents.

### You can verify us

You hand over an endpoint and credentials, so "trust us" is not good enough:

```bash
$ npx spigot.sh calls
WHEN                   ENDPOINT   STATUS  EARNED    PAID BY TX
15/8/2026, 1:48:58 am  GET /json  200     0.009500  6P6PNPLJSOTEWFXI…
✓ Every call is backed by an on-chain payment.
```

Every request carries the Arc transaction that paid for it. Reconcile that against your
own access logs: a request your server saw that is missing here, or a row with no
transaction, is a discrepancy worth raising.

Your upstream URL and credentials are never returned by any public endpoint, and are
encrypted at rest.

---

## For API consumers

**Buy credit once, then just call.**

```bash
curl -X POST https://gateway.example.com/api/consume/weather-api-x2q \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"endpointId":"ep_123"}'
```

```json
{
  "ok": true,
  "response": { "temperature": 18.5, "condition": "Partly Cloudy" },
  "balance": 4.49,
  "payment": {
    "txId": "ITJAEDLDQOAJUJJGGR7C3GUVYVSDYXNUWQEMZCSB4XYNI5FSDICA",
    "amountUsdc": 0.01,
    "gasPaidByFacilitator": true
  }
}
```

**Or pay per request with your own wallet** — the gateway is a standards-compliant HTTP 402
resource server supporting native Nanopayments:

```
GET /nanopay/{apiSlug}/{path}  →  402 + NANOPAYMENT-REQUIRED challenge
                               →  retry with NANOPAYMENT-SIGNATURE
                               →  200 + NANOPAYMENT-RESPONSE (settled txid)
```

### Any language

[`openapi.yaml`](./openapi.yaml) documents the whole API. Generate a client for your stack:

```bash
npx @openapitools/openapi-generator-cli generate \
  -i openapi.yaml -g python -o ./client      # or go, rust, java, csharp, php…
```

---

## Architecture

```
backend/    Express 5 + SQLite   gateway, nanopayments, credit ledger, custody
cli/        Node                 publisher tooling (npx spigot.sh)
(frontend is maintained separately in ../spigot-website)
```

**Three separate accounts**, because money held _for_ users, money _earned_ from users, and
money spent _running_ the platform are different things:

| Account    | Holds | Role                                           |
| ---------- | ----- | ---------------------------------------------- |
| Operations | USDC  | network costs on Arc Testnet                   |
| Custody    | USDC  | user credit balances; the payer for every call |
| Settlement | USDC  | the `payTo`; revenue and publisher payouts     |

Each has its own solvency check, reported at boot and on `/admin/status`.

**Credit is an append-only ledger.** Balances are derived from it rather than stored in a
mutable column, so they can always be recomputed and can never disagree with their own
history. Debits are atomic and refuse to go negative — which is what stops a concurrent
request from spending the same credit twice.

Payments settle on Arc Testnet via Nanopayments (EIP-3009 transferWithAuthorization)
or gasless facilitator payments.

---

## Documentation

| Document                       | What it answers                                                 |
| ------------------------------ | --------------------------------------------------------------- |
| [flow.md](./flow.md)           | Entry points, boot order, and what calls what                   |
| [discuss.md](./discuss.md)     | Every design decision, its reason, and the rejected alternative |
| [SECURITY.md](./SECURITY.md)   | Threat model, adversarial test results, open risks              |
| [mainnet.md](./mainnet.md)     | Going live, and the mistakes that cost money                    |
| [deploy.md](./deploy.md)       | Deploying to Railway from GitHub                                |
| [openapi.yaml](./openapi.yaml) | Full API reference; generates clients in 40+ languages          |

All four are written to be tool-agnostic — point any AI assistant or new engineer at them
and they have the full picture without needing the history.

---

## Security

This platform is custodial: it holds user credit and publisher revenue and signs payments on
their behalf. That is treated as a threat model, not an afterthought.

- Custodial keys are AES-256-GCM encrypted at rest and never leave the server
- Sessions are opaque tokens stored only as hashes, and are revocable
- Payment requirements are always rebuilt server-side, so a caller cannot claim a tier they
  did not pay for
- Replay is blocked by a payment fingerprint checked before any on-chain work
- Publisher payout changes require an emailed confirmation
- Upstream credentials are withheld from every public response and encrypted at rest

35 adversarial probes were run against a live instance, as an outsider with no credentials
and as a signed-in user trying to cheat. Four real findings came out of it — including a
concurrency race that let one credit pay for three calls — all fixed and re-tested.
[SECURITY.md](./SECURITY.md) records what was tested, what broke, and what is still open.

---

## Going to mainnet

One line:

```bash
ARC_NETWORK_PROFILE=mainnet
```

That derives the Arc network configuration, USDC contract, RPC, and explorer URLs
together, so they cannot disagree. Read [mainnet.md](./mainnet.md) first.

---

## Licence

**Proprietary — all rights reserved.** This repository is source-visible, not open
source. No right to use, copy, modify, host or distribute the software is granted. See
[LICENSE](./LICENSE).

Versions released before this change were published under the MIT Licence; that grant is
not revoked for those versions.

For licensing enquiries, contact the copyright holder.
