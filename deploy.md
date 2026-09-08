# deploy.md — Railway

## Why this file exists

**Tool-agnostic**, like the other docs. Point any assistant or engineer at it and they can
deploy without the original conversation.

Deployment is from **GitHub → Railway**: push to the branch, Railway builds and deploys. You
never deploy from a laptop, so a local machine can never become the source of truth.

> ### Read this before your first deploy
>
> The app currently stores everything in **SQLite**. Railway containers have an **ephemeral
> filesystem** — every deploy replaces it. Without the volume in step 4 you will lose the
> credit ledger, user accounts and custodial wallet records **on every single deploy**.
> Money users paid for would vanish.
>
> The volume makes this safe. Migrating to Postgres removes the constraint entirely and is
> the prerequisite for running more than one instance — see the last section.

---

## 1. Create the project

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Authorise Railway and pick `x402-algorand`
3. Choose the branch you want deployed (`main` after you merge)

Railway will detect the monorepo. Delete whatever single service it auto-creates — you are
adding two deliberately.

## 2. Backend service

**New** → **GitHub Repo** → same repo.

| Setting        | Value                                   |
| -------------- | --------------------------------------- |
| Service name   | `backend`                               |
| Root Directory | `backend`                               |
| Config file    | `railway.toml` (detected automatically) |

`backend/railway.toml` already sets the build and start commands. The build installs the
whole workspace from the repo root, because the backend depends on the root lockfile.

Then **Settings → Networking → Generate Domain**. Note the URL, e.g.
`backend-production-abcd.up.railway.app`.

## 3. Frontend service

**New** → **GitHub Repo** → same repo again.

| Setting        | Value      |
| -------------- | ---------- |
| Service name   | `frontend` |
| Root Directory | `frontend` |

Generate a domain for this one too. That is the URL your users visit.

## 4. Volume for the database — do not skip

On the **backend** service: **Settings → Volumes → New Volume**

| Setting    | Value          |
| ---------- | -------------- |
| Mount path | `/app/data`    |
| Size       | 1 GB is plenty |

Then set `DATABASE_PATH=/app/data/x402.db` in the backend variables.

Without this the database is wiped on every deploy. With it, data survives.

## 5. Environment variables

### Backend

Generate the secrets first, locally:

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # MASTER_ENCRYPTION_KEY
openssl rand -hex 32   # ADMIN_TOKEN
```

| Variable                   | Value                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| `NODE_ENV`                 | `production`                                                        |
| `DATABASE_PATH`            | `/app/data/x402.db`                                                 |
| `ALGORAND_NETWORK_PROFILE` | `testnet` (or `mainnet` — read [mainnet.md](./mainnet.md) first)    |
| `GATEWAY_BASE_URL`         | your backend domain, with `https://`                                |
| `APP_BASE_URL`             | your **frontend** domain, with `https://`                           |
| `TREASURY_MNEMONIC`        | operations account, 25 words                                        |
| `SETTLEMENT_MNEMONIC`      | revenue account                                                     |
| `CUSTODY_MNEMONIC`         | user credit float                                                   |
| `SESSION_SECRET`           | generated above                                                     |
| `MASTER_ENCRYPTION_KEY`    | generated above — **back it up, it is unrecoverable**               |
| `ADMIN_TOKEN`              | generated above                                                     |
| `RESEND_API_KEY`           | required in production; without it sign-in codes only print to logs |
| `EMAIL_FROM`               | e.g. `Spigot <noreply@yourdomain.com>`                              |
| `GOOGLE_CLIENT_ID`         | optional; omit to offer magic link and code only                    |
| `SIGNUP_USDC_GRANT`        | `0`                                                                 |

Leave these blank for Algorand only. Fill them in to settle on EVM or Solana as well:

| Variable                        | Value                                     |
| ------------------------------- | ----------------------------------------- |
| `EVM_SETTLEMENT_ADDRESS`        | EVM address that receives settlement      |
| `EVM_SETTLEMENT_PRIVATE_KEY`    | its key, for walletless custody payments  |
| `SOLANA_SETTLEMENT_ADDRESS`     | Solana treasury address                   |
| `SOLANA_SETTLEMENT_PRIVATE_KEY` | base64 keypair secret                     |
| `TREASURY_MNEMONIC_SOLANA`      | 12-word BIP39 mnemonic for Solana payouts |

Leave `EVM_ENABLED_CHAINS` and `SOLANA_RPC_URL` **unset** so they follow
`ALGORAND_NETWORK_PROFILE`. Setting them by hand is how you end up on mainnet with testnet
chain constants, which is what the boot guard in `config.ts` exists to catch.

`NODE_ENV=production` matters: it makes missing secrets fatal, disables the domain
verification bypass, and stops 5xx responses leaking internal errors.

`backend/.env.example` documents every remaining variable.

### Frontend

| Variable                               | Value                                  | Scope            |
| -------------------------------------- | -------------------------------------- | ---------------- |
| `BACKEND_ORIGIN`                       | `http://backend.railway.internal:4402` | server-side only |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID`         | same as `GOOGLE_CLIENT_ID`, if used    | browser          |
| `NEXT_PUBLIC_ALGORAND_NETWORK_PROFILE` | `testnet` or `mainnet`                 | browser          |

Use the **private network** address for `BACKEND_ORIGIN`, not the public domain. Both the
`/api` rewrite and the server-rendered marketplace run inside Railway, so the public URL means
leaving the network and coming back for every call. `http://backend.railway.internal:4402` is
the service name plus the port the backend listens on. The public `https://` domain works, it
is just slower and pointless.

`NEXT_PUBLIC_*` values are baked in at build time, so **changing them requires a redeploy**,
not a restart. `BACKEND_ORIGIN` is read at runtime, so a restart picks it up.

**Do not set `NEXT_PUBLIC_BACKEND_URL`.** Next rewrites `/api` and `/x402` to
`BACKEND_ORIGIN`, so the browser stays on the frontend origin and the `SameSite=Lax` session
cookie is sent with every API call. Setting it makes those calls cross-origin, and the
browser will then drop the cookie — sign-in appears to succeed and every later request comes
back unauthenticated.

Because the browser only talks to the frontend origin, CORS is no longer in the request path
for normal use. `APP_BASE_URL` on the backend should still match the frontend domain: it is
what magic-link emails redirect to.

## 6. Fund the accounts

Send ALGO to all three addresses and USDC to settlement and custody. On the first boot the
backend opts each into USDC automatically and logs the result.

Confirm:

```bash
curl https://your-backend.up.railway.app/health
# {"status":"ok","network":"testnet","usdcAssetId":10458941,"facilitator":"up"}

curl -H "x-admin-token: $ADMIN_TOKEN" https://your-backend.up.railway.app/admin/status
# accounts, balances, and both solvency positions
```

## 7. Deploy

### The homepage may be empty on the first deploy

`/` is prerendered at build time and revalidates every 60 seconds. If the frontend builds
before the backend is reachable, the listing fetch returns `[]` and the page bakes in empty.
It corrects itself within a minute of the first request.

That is deliberate: `getMarketplaceApis()` returns an empty array rather than throwing, because
an empty marketplace is recoverable and a page that throws during render is a 500 for every
visitor including crawlers. So an empty homepage right after the first deploy is expected, not
a fault. If it is still empty after a few minutes, check `BACKEND_ORIGIN` and that the backend
service is healthy.

Push to the connected branch. Railway builds both services and deploys. Watch **Deployments
→ View Logs**; a healthy backend prints:

```
Spigot running on port 4402
Facilitator ready: https://facilitator.goplausible.xyz covers algorand:…
Operations (funds wallets): F6Y3… — ready
Settlement (receives payments): AJE4… — ready
Custody (holds user credits): OCNN… — ready
Vendor liability 0.000000 USDC against … held
User credits outstanding 0.000000 USDC against … held
```

Any `Warning:` line there is a real misconfiguration — read it before taking payments.

---

## Troubleshooting

| Symptom                                             | Cause                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Data resets on every deploy                         | No volume, or `DATABASE_PATH` not pointing into it                                                                                         |
| Sign-in codes never arrive                          | `RESEND_API_KEY` unset — check logs, they print there                                                                                      |
| Frontend calls `localhost`, or `/api` 502s          | `BACKEND_ORIGIN` unset — the rewrite falls back to `http://127.0.0.1:4402`                                                                 |
| Signed in, but every request is unauthenticated     | `NEXT_PUBLIC_BACKEND_URL` is set, making calls cross-origin so the `SameSite=Lax` cookie is dropped. Unset it and rely on the rewrite      |
| Build fails on `@walletconnect/*` or `lute-connect` | A wallet was added to `walletManager.ts` without installing its package or removing it from the alias list in `next.config.ts`             |
| Boot warns an account is short                      | Send it at least 0.2 ALGO so it can opt into USDC                                                                                          |
| Payments fail with an asset mismatch                | Network profile and USDC asset disagree — leave the overrides blank                                                                        |
| Build fails on a missing package                    | Root Directory not set, so the workspace root was not installed                                                                            |
| Backend exits at boot on mainnet                    | The mainnet guard in `config.ts` refused the config. It prints every problem at once, usually a `.env` carrying leftover testnet overrides |
| Homepage lists no APIs right after deploying        | Expected. `/` prerendered before the backend was up and revalidates within 60s. See §7                                                     |

---

## Moving to Postgres

The volume makes SQLite safe on one instance. Postgres is what you need for two, and it is
**not** just a connection-string change:

- `better-sqlite3` is **synchronous**; every `db.prepare().get/all/run` becomes `await`
- ~15 files hold query call sites
- The credit ledger's atomic debit — which is what stops one credit paying for several calls
  — relies on a single writer today. In Postgres it must become `SELECT … FOR UPDATE` or a
  serializable transaction. **Getting this wrong reintroduces a fund-draining bug.**
- Rate limiting also moves to a shared store, or instances will not agree

Do it as its own piece of work, with the concurrency test from [SECURITY.md](./SECURITY.md)
§7 re-run afterwards: give a user credit for exactly one call, fire several concurrent
requests, and confirm exactly one succeeds.

Until then, run **one** backend instance. Do not scale replicas above 1.
