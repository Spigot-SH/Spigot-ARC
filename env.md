# env.md — Every Variable, Where To Get It

Copy from `backend/.env.example` to `backend/.env` and fill in secrets:

| File           | Copy from              | Who reads it                          |
| -------------- | ---------------------- | ------------------------------------- |
| `backend/.env` | `backend/.env.example` | `backend/src/config.ts`, once at boot |

_(Frontend environment variables are documented in `../spigot-website`)_

**Nothing outside `config.ts` reads `process.env` in the backend.** New setting → add it to
`config.ts` _and_ to `.env.example`.

---

## 1. Generate these yourself — 30 seconds, no account needed

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # MASTER_ENCRYPTION_KEY
openssl rand -hex 32   # ADMIN_TOKEN
openssl rand -hex 32   # ONRAMP_WEBHOOK_SECRET   (only if you wire a fiat onramp)
```

| Variable                | What it does                                      | If you skip it                                                                                      |
| ----------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`        | Signs session cookies                             | Dev: auto-generated into `backend/data/.dev-session_secret`. **Production: server refuses to boot** |
| `MASTER_ENCRYPTION_KEY` | AES-256-GCM key for custodial wallet keys at rest | Same. ⚠️ **Changing it makes every existing wallet permanently unreadable**                         |
| `ADMIN_TOKEN`           | Guards `/admin/status`                            | That endpoint returns 503                                                                           |
| `ONRAMP_WEBHOOK_SECRET` | HMAC for the fiat top-up webhook                  | Webhook returns 503 (fails closed — correct)                                                        |

> **Before your first production deploy**, copy the two dev-generated values out of
> `backend/data/.dev-session_secret` and `.dev-master_encryption_key`, or the 4 existing
> custodial wallets become unreadable. Back up `MASTER_ENCRYPTION_KEY` somewhere you cannot
> lose it — there is no recovery.

---

## 2. Arc Testnet & Multi-Chain Accounts

### Arc Testnet (Circle Arc L1 — Primary Default)

Arc uses **native USDC for gas** and standard EVM addresses (`0x...`). There are no ASA opt-ins.

```bash
# Generate Arc private keys:
openssl rand -hex 32   # ARC_TREASURY_PRIVATE_KEY (operations)
openssl rand -hex 32   # ARC_SETTLEMENT_PRIVATE_KEY (settlement)
openssl rand -hex 32   # ARC_CUSTODY_PRIVATE_KEY (custody)
```

| Variable                     | Account          | Network                                      | Description                                                       |
| ---------------------------- | ---------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| `ARC_TREASURY_PRIVATE_KEY`   | Operations       | Arc Testnet (5042002)                        | Funds user wallets with gas/USDC and covers operational transfers |
| `ARC_SETTLEMENT_PRIVATE_KEY` | Settlement       | Arc Testnet (5042002)                        | Receives API payment revenues and settles publisher payouts       |
| `ARC_CUSTODY_PRIVATE_KEY`    | Custody          | Arc Testnet (5042002)                        | Holds user prepaid credits; authorizes nanopayments (EIP-3009)    |
| `ARC_RPC_URL`                | RPC              | `https://rpc.testnet.arc.network`            | Public JSON-RPC endpoint for Arc Testnet                          |
| `ARC_USDC_ADDRESS`           | Native Gas/Token | `0x3600000000000000000000000000000000000000` | Canonical 6-decimal USDC on Arc Testnet                           |

### Algorand accounts (Secondary / Multi-chain)

You can also configure three separate Algorand accounts if supporting Algorand:

**Generate them:**

```bash
node -e "
const a=require('algosdk');
for (const n of ['TREASURY (operations)','SETTLEMENT (revenue)','CUSTODY (user credits)']) {
  const acc=a.generateAccount();
  console.log('\n'+n);
  console.log('  address :', acc.addr.toString());
  console.log('  mnemonic:', a.secretKeyToMnemonic(acc.sk));
}"
```

**Fund them** at the TestNet dispenser — <https://bank.testnet.algorand.network/> — paste each
address. For USDC on testnet use the Circle faucet: <https://faucet.circle.com/> (select
Algorand Testnet).

| Variable                | Account        | Needs                  | Why                                                                                     |
| ----------------------- | -------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `TREASURY_MNEMONIC`     | Operations     | ~2 ALGO                | Pays the 0.201 ALGO that activates each user wallet. Your cost of doing business        |
| `TREASURY_MNEMONIC_EVM` | EVM Operations | testnet ETH/USDC       | Funds user EVM custodial wallets across supported EVM networks upon top-up              |
| `SETTLEMENT_MNEMONIC`   | Settlement     | ~0.5 ALGO + USDC float | The x402 `payTo`. Every API payment lands here; every publisher payout leaves from here |
| `CUSTODY_MNEMONIC`      | Custody        | ~0.5 ALGO + USDC float | Holds users' unspent credit and pays for every API call on their behalf                 |

Each needs a little ALGO to opt into USDC — the backend does the opt-in automatically on first
boot and logs the result.

> Leaving `SETTLEMENT_MNEMONIC` blank falls back to `TREASURY_MNEMONIC` and the server warns at
> boot that the two pots are commingled. Don't ship that.

**For mainnet, read [mainnet.md](./mainnet.md) first.** One variable switches the network:
`ALGORAND_NETWORK_PROFILE=mainnet`.

---

## 3. Third-party accounts — only these two, both optional

### Resend — transactional email

1. Sign up at <https://resend.com> (free tier is generous)
2. **API Keys** → **Create API Key** → copy the `re_…` value
3. `RESEND_API_KEY=re_...`
4. `EMAIL_FROM="Spigot <noreply@yourdomain.com>"` — the domain must be verified under
   **Domains**, or use `onboarding@resend.dev` for testing

**Without it**, magic links and OTP codes print to the server console instead of sending. Fine
locally; **required in production** or nobody can sign in.

### Google Identity Services — "Sign in with Google"

1. <https://console.cloud.google.com/apis/credentials>
2. **Create Credentials** → **OAuth client ID** → **Web application**
3. Authorised JavaScript origins: `http://localhost:5173` and your production frontend URL
4. Copy the client ID (ends `.apps.googleusercontent.com`)
5. Set it in **both** files — they must match exactly:
   - `backend/.env`: `GOOGLE_CLIENT_ID=...`
   - `frontend/.env.local`: `NEXT_PUBLIC_GOOGLE_CLIENT_ID=...`

**Without it**, the Google button is hidden and `/auth/google` returns 503. Magic link and OTP
still work, so this is genuinely optional.

### Turso — optional SQLite replication

Only if you want a replica. <https://turso.tech> → create a database → copy the URL and token
into `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`. Blank = pure local SQLite, which is the default
and is fine.

---

## 4. No account needed — these have working defaults

| Variable                                  | Default                 | Change it when                                                                                                                         |
| ----------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                    | `4402`                  | Port clash                                                                                                                             |
| `NODE_ENV`                                | `development`           | **Set `production` when deploying.** Makes missing secrets fatal, disables the domain-verification bypass, stops 5xx leaking internals |
| `DATABASE_PATH`                           | `./data/x402.db`        | On Railway set `/app/data/x402.db` and mount a volume, or every deploy wipes the ledger                                                |
| `ALGORAND_NETWORK_PROFILE`                | `testnet`               | Going live. Derives the Algorand network, USDC asset, algod, indexer and explorer, **and** every EVM and Solana chain constant         |
| `FACILITATOR_URL`                         | GoPlausible             | You run your own facilitator for Algorand                                                                                              |
| `EVM_FACILITATOR_URL`                     | `facilitator.x402.rs`   | You run or use a different EVM facilitator (e.g. Coinbase CDP)                                                                         |
| `EVM_ENABLED_CHAINS`                      | follows the profile     | Limit enabled EVM chains. Blank takes the profile list: 6 on testnet, 5 on mainnet (`robinhood` has no verified mainnet constants)     |
| `EVM_SETTLEMENT_ADDRESS`                  | blank                   | EVM wallet address to receive settlement funds and fund custodial calls                                                                |
| `EVM_SETTLEMENT_PRIVATE_KEY`              | blank                   | EVM private key for walletless custody payments                                                                                        |
| `SOLANA_FACILITATOR_URL`                  | `facilitator.x402.rs`   | Solana facilitator URL for verification & settlement                                                                                   |
| `SOLANA_ENABLED_CHAINS`                   | `solana`                | Enabled Solana networks                                                                                                                |
| `SOLANA_SETTLEMENT_ADDRESS`               | blank                   | Solana treasury/settlement address                                                                                                     |
| `SOLANA_SETTLEMENT_PRIVATE_KEY`           | blank                   | Base64 Solana keypair secret for treasury payouts                                                                                      |
| `TREASURY_MNEMONIC_SOLANA`                | blank                   | 12-word BIP39 mnemonic for Solana treasury operations and settlement payouts                                                           |
| `SOLANA_RPC_URL`                          | follows the profile     | Private RPC. Blank gives devnet on testnet, mainnet-beta on mainnet                                                                    |
| `STELLAR_FACILITATOR_URL`                 | `facilitator.x402.rs`   | Stellar facilitator URL for verification & settlement                                                                                  |
| `STELLAR_ENABLED_CHAINS`                  | `stellar`               | Enabled Stellar networks                                                                                                               |
| `STELLAR_SETTLEMENT_ADDRESS`              | blank                   | Stellar treasury/settlement public key (`G...`)                                                                                        |
| `STELLAR_SETTLEMENT_SECRET`               | blank                   | Stellar secret key (`S...`) for settlement payouts                                                                                     |
| `TREASURY_SECRET_STELLAR`                 | blank                   | Stellar secret key (`S...`) for treasury operations and testnet funding                                                                |
| `TREASURY_MNEMONIC_STELLAR`               | blank                   | 12-word BIP39 mnemonic for Stellar treasury operations                                                                                 |
| `STELLAR_RPC_URL`                         | follows the profile     | Soroban RPC URL. Blank gives testnet RPC on testnet, public RPC on mainnet                                                             |
| `STELLAR_HORIZON_URL`                     | follows the profile     | Stellar Horizon URL. Blank gives testnet Horizon on testnet, public Horizon on mainnet                                                 |
| `GATEWAY_BASE_URL`                        | `http://localhost:4402` | Your backend's public URL                                                                                                              |
| `APP_BASE_URL`                            | `http://localhost:5173` | Your frontend's public URL — magic links redirect here                                                                                 |
| `PLATFORM_FEE_PERCENT`                    | `5`                     | Different commission                                                                                                                   |
| `MIN_RECHARGE_USDC` / `MAX_RECHARGE_USDC` | `1` / `1000`            | Different top-up bounds. **`MAX` also caps the onramp webhook**                                                                        |
| `WALLET_FUNDING_MICROALGOS`               | `201000`                | Rarely                                                                                                                                 |
| `SIGNUP_USDC_GRANT`                       | `0`                     | Keep at 0 unless you mean to give money away                                                                                           |
| `DOMAIN_VERIFY_BYPASS`                    | `true` in dev           | Ignored in production regardless                                                                                                       |
| `EVM_CHAIN_OVERRIDES_JSON`                | blank                   | A private RPC for one chain, or constants for a chain with no built-in mainnet entry. `{"base":{"rpcUrl":"https://…"}}`                |

Everything else is documented inline in `backend/.env.example`.

### Starting points

Two ready-to-copy templates rather than editing `.env.example` by hand:

```bash
cp backend/.env.testnet.example backend/.env     # local development
cp backend/.env.mainnet.example backend/.env     # then fill in every blank
```

The mainnet template lists only what you must supply. Everything network-shaped is derived,
and `config.ts` refuses to boot on mainnet if any of it is still pointed at a test network.
See mainnet.md §1.

---

## 5. Frontend environment

Frontend environment variables (`.env.local`) are maintained in the separate `spigot-website`
project directory (`../spigot-website/.env.example`).
In that project, `BACKEND_ORIGIN` points to this backend origin (`http://127.0.0.1:4402`).

---

## 6. Minimum to run locally

```bash
cp backend/.env.example backend/.env
```

Then fill in **only** the three mnemonics. Everything else has a working default, secrets are
auto-generated in dev, and sign-in codes print to the console. Then:

```bash
npm install
npm run dev        # backend :4402
```

A healthy boot prints all three accounts as `ready` with **no `Warning:` lines**, plus two
solvency lines. Any `Warning:` is a real misconfiguration — read it before taking payments.
