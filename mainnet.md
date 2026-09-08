# mainnet.md — Going Live

## Why this file exists (read this first)

**Model-agnostic and tool-agnostic**, like `discuss.md` and `flow.md`. Point any AI tool or
new engineer at it and they can perform the switchover without the chat history.

This is the checklist for moving from Algorand testnet to mainnet, where **transactions
move real money and mistakes are not reversible**. Work top to bottom and do not skip the
verification step — it is the only thing between a config typo and real USDC going to an
address you do not control.

---

## 1. The switch itself is one line

```bash
# backend/.env
ALGORAND_NETWORK_PROFILE=mainnet
```

That single value derives everything network-specific. Verified by running the config with
the profile flipped:

| Value          | testnet                                                 | mainnet                                                 |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| CAIP-2 network | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |
| USDC ASA       | `10458941`                                              | `31566704`                                              |
| algod          | `testnet-api.algonode.cloud`                            | `mainnet-api.algonode.cloud`                            |
| indexer        | `testnet-idx.algonode.cloud`                            | `mainnet-idx.algonode.cloud`                            |
| explorer       | `testnet.explorer.perawallet.app`                       | `explorer.perawallet.app`                               |

The profile also drives every **EVM and Solana** constant, not just Algorand:

| Value          | testnet                  | mainnet                             |
| -------------- | ------------------------ | ----------------------------------- |
| EVM chains     | Sepolia / Fuji, 6 chains | mainnet, 5 chains                   |
| EVM chain ids  | `11155111`, `84532`, …   | `1`, `8453`, `42161`, `10`, `43114` |
| EVM USDC       | testnet deployments      | canonical Circle deployments        |
| Solana cluster | devnet                   | mainnet-beta                        |
| Solana USDC    | `4zMMC9srt5…`            | `EPjFWdd5Aufq…`                     |
| Solana RPC     | `api.devnet.solana.com`  | `api.mainnet-beta.solana.com`       |

`robinhood` is enabled on testnet but **absent from the mainnet table**: its mainnet chain id,
USDC address and RPC could not be verified, and a wrong token address on mainnet spends real
money into a contract nobody owns. It is excluded from the mainnet `EVM_ENABLED_CHAINS`
default. Enabling it requires supplying the constants explicitly:

```bash
EVM_CHAIN_OVERRIDES_JSON='{"robinhood":{"chainId":…,"caip2":"eip155:…","usdcAddress":"0x…","rpcUrl":"https://…","explorerUrl":"https://…"}}'
```

An enabled chain with no definition throws at boot rather than silently disappearing.

The facilitator URL does **not** change — `https://facilitator.goplausible.xyz` serves both.

Leave `ALGORAND_NETWORK`, `USDC_ASA_ID`, `ALGORAND_NODE_URL`, `ALGORAND_INDEXER_URL`,
`EXPLORER_BASE_URL`, `EVM_ENABLED_CHAINS` and `SOLANA_RPC_URL` **blank** so they follow the
profile. Setting them individually is how you end up on mainnet with a testnet asset id.

### The boot guard

That mistake is no longer silent. On mainnet, `config.ts` refuses to start if:

- `TREASURY_MNEMONIC` or `SETTLEMENT_MNEMONIC` is unset
- `DOMAIN_VERIFY_BYPASS` is on
- `USDC_ASA_ID` is not `31566704`
- `ALGORAND_NETWORK` is overridden to a non-mainnet CAIP-2 identifier
- `ALGORAND_NODE_URL` or `EXPLORER_BASE_URL` still contains `testnet`
- `SOLANA_RPC_URL` still points at devnet or testnet

It reports every problem at once, then exits. This catches the most likely failure by far: a
`.env` carrying leftover testnet overrides from local development.

Definition lives in `backend/src/config.ts` → `NETWORK_PROFILES`, and the per-chain tables in
`backend/src/services/chains.ts` → `EVM_CHAINS_BY_PROFILE`.

---

## 2. Generate fresh mainnet accounts

**Never reuse a testnet mnemonic on mainnet.** Testnet keys have been in logs, scratch
files and terminal history. Generate three new ones:

```bash
cd backend
node -e "const a=require('algosdk');for(const n of ['OPERATIONS','SETTLEMENT','CUSTODY']){const k=a.generateAccount();console.log(n+'_ADDRESS='+k.addr.toString());console.log(n+'_MNEMONIC='+a.secretKeyToMnemonic(k.sk));console.log()}"
```

Put them in `backend/.env` as `TREASURY_MNEMONIC` (operations), `SETTLEMENT_MNEMONIC`,
`CUSTODY_MNEMONIC`. Store the mnemonics in a password manager — losing `CUSTODY_MNEMONIC`
loses every user's balance, and losing `SETTLEMENT_MNEMONIC` loses every vendor's revenue.

### Fund and opt in

Each account needs a little ALGO before it can hold USDC (0.1 minimum balance per ASA plus
fees). Send **at least 0.5 ALGO** to each, then start the server once — `ensureTreasuryReady()`
opts all three into USDC automatically at boot and logs the result.

| Account    | Needs                                                                |
| ---------- | -------------------------------------------------------------------- |
| Operations | ALGO only. Sized for wallet activations if you re-enable them.       |
| Settlement | A little ALGO. Receives all revenue; the `payTo` on the leaderboard. |
| Custody    | A little ALGO, plus USDC float matching user credits.                |

**The `payTo` you launch with is the one you must keep for the whole competition** — the
leaderboard attributes your entry by that address. Decide it once, then do not change it.

---

## 3. Rotate every secret

Development secrets are auto-generated and cached under `backend/data/`. In production the
server refuses to boot without them.

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # MASTER_ENCRYPTION_KEY
openssl rand -hex 32   # ADMIN_TOKEN
openssl rand -hex 32   # ONRAMP_WEBHOOK_SECRET (only if enabling fiat)
```

`MASTER_ENCRYPTION_KEY` encrypts custodial keys at rest. **Changing it later orphans every
encrypted key.** Set it once, back it up, never rotate casually.

Also set:

```bash
NODE_ENV=production          # enforces secrets, disables DOMAIN_VERIFY_BYPASS,
                             # and stops 5xx errors echoing internals
GATEWAY_BASE_URL=https://your-domain.com
APP_BASE_URL=https://your-domain.com
SIGNUP_USDC_GRANT=0          # never give away real USDC
```

---

## 4. Competition requirements

From the Global x402 Challenge checklist:

- [ ] **HTTPS on a real domain.** Not localhost. `GATEWAY_BASE_URL` must be the public URL.
- [ ] **GoPlausible facilitator** — already the default; do not point at a local one.
- [ ] **Challenge tag** — `X402_CHALLENGE_TAG=x402-global-challenge`, emitted in every
      payment requirement's `extra.tag`. Already wired in `services/x402.ts`.
- [ ] **Bazaar discovery** — emitted as `extensions.bazaar` on every 402. Already wired.
- [ ] **Merchant metadata** — set `MERCHANT_NAME`, `MERCHANT_WEBSITE`, `MERCHANT_LOGO`,
      `MERCHANT_CATEGORIES`. This is what your merchant card shows in the Bazaar.
- [ ] **One payTo per domain.** Sharing a `payTo` across different domains is against the
      competition rules. One merchant account, one root domain.
- [ ] **Concrete endpoint descriptions.** The catalog shows `endpoint.description`. Say what
      the caller _receives_ — "Real-time weather: temperature, conditions and 3-day forecast
      for a given city", not "weather data access".
- [ ] **Your domain metadata** — title, description, logo, `.well-known` — is what the Bazaar
      scrapes to enrich your merchant page. Update it before the first settlement.

---

## 5. Pre-flight verification

Run these **before** taking real payments.

```bash
# 1. Confirm the profile actually took effect
curl -s https://your-domain.com/health
#    expect: "network":"mainnet","usdcAssetId":31566704

# 2. Confirm accounts are funded, opted in and solvent
curl -s -H "x-admin-token: $ADMIN_TOKEN" https://your-domain.com/admin/status

# 3. Inspect a real 402 challenge
curl -s https://your-domain.com/x402/<slug>/<path> | jq '{
  description: .resource.description,
  network: .accepts[0].network,
  asset: .accepts[0].asset,
  payTo: .accepts[0].payTo,
  tag: .accepts[0].extra.tag,
  extensions: (.extensions | keys)
}'
```

Every one of these must be true:

- `network` is the **mainnet** CAIP-2 string
- `asset` is **31566704**
- `payTo` is **your mainnet settlement address**
- `tag` is **x402-global-challenge**
- `extensions` contains **bazaar** and **x402-merchant**

Then make **one real mainnet payment** end to end, confirm the USDC lands in `payTo`, and
check the leaderboard with the global hackathon filter on.

---

## 6. Things that will bite you

| Trap                                                               | Consequence                                                                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Reusing a testnet mnemonic                                         | Keys have been in logs and scratch files. Treat as public.                                                                        |
| Forgetting the USDC opt-in                                         | Incoming transfers are **rejected on chain** and the sender keeps their money. This already cost one transfer during development. |
| Setting `ALGORAND_NETWORK` by hand and leaving `USDC_ASA_ID` blank | Mainnet network with the testnet asset. Every payment fails verification.                                                         |
| Changing `payTo` mid-competition                                   | Leaderboard attribution splits across two merchant rows.                                                                          |
| Changing `MASTER_ENCRYPTION_KEY`                                   | Every stored custodial key becomes undecryptable.                                                                                 |
| `NODE_ENV` not `production`                                        | Domain verification bypass stays available and 5xx errors leak internals.                                                         |
| Custody holding less USDC than credits sold                        | Users cannot spend what they paid for. Watch `custodySolvent` on `/admin/status`.                                                 |

---

## 7. Rollback

The switch is reversible while no real funds are in play: set
`ALGORAND_NETWORK_PROFILE=testnet` and restart. Mainnet balances stay where they are — the
accounts are unrelated to the testnet ones. Any credits users bought on mainnet remain in
the ledger, so do not serve testnet traffic from a database that has sold real credits.
