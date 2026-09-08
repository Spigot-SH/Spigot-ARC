# verify.md — Post-Change Verification Runbook

## Why this file exists

Run this after any large change — a framework upgrade, a dependency bump, a refactor that
touches many files — to confirm the app is still whole. It is written to be **tool-agnostic**:
a human or any AI assistant can follow it without the conversation that produced it.

It is deliberately ordered **cheapest-first**. Each gate is a hard stop: if a gate fails, fix
it before running the next one, because later gates assume the earlier ones passed.

**Nothing here mutates state except Gate 6, which is clearly marked.**

---

## Gate 0 — Clean tree

```bash
git status --short          # know what you are about to verify
git stash list              # make sure nothing is hiding
```

---

## Gate 1 — Static checks (fast, no servers needed)

```bash
npm run verify
```

That is `format:check` → `lint` → `typecheck` → `build`, chained. Or run them individually:

| Command                | Passes when                                  |
| ---------------------- | -------------------------------------------- |
| `npm run format:check` | `All matched files use Prettier code style!` |
| `npm run lint`         | **0 errors, 0 warnings**                     |
| `npm run typecheck`    | no output from backend workspace             |
| `npm run build`        | backend `tsc` clean, compiles to `dist/`     |

**Current accepted baseline:** 0 errors, **0 warnings**. Any warning is new and should be
looked at rather than absorbed.

`@typescript-eslint/no-explicit-any` is now **`error`**, not `warn`, so a new `any` fails the
build. If an upstream shape is genuinely unknowable, type it `unknown` and narrow it — do not
reintroduce `any` and do not disable the rule.

_(Frontend verification is handled in `../spigot-website`)_

---

## Gate 2 — Tailwind sanity

Two classes of silent breakage that no compiler catches. Both must return nothing.

```bash
# 1. Arbitrary values containing spaces. The browser splits the class attribute on
#    whitespace, so these produce NO CSS and fail invisibly.
grep -rnE "(bg|text|border|shadow)-\[[^]]* [^]]*\]" frontend/src --include='*.tsx'

# 2. Raw var() escape hatches. The @theme block generates real utilities — `bg-panel`,
#    `text-muted`, `border-border` — so `bg-[var(--color-panel)]` means someone bypassed
#    the design system.
grep -rn "\[var(--color-" frontend/src --include='*.tsx' --include='*.ts'
```

Then confirm the theme utilities still resolve through CSS variables, which is what makes
light/dark switching work:

```bash
CSS=$(find frontend/.next -name '*.css' | head -1)
grep -oE "\.bg-panel\{[^}]*\}|\.text-muted\{[^}]*\}" "$CSS"
# expect: .bg-panel{background-color:var(--color-panel)}
#         .text-muted{color:var(--color-muted)}
```

If those resolve to a **literal hex** instead of `var(...)`, theme switching is broken.

**Inline styles:** exactly one is expected, in `views/Dashboard.tsx` (a runtime width value
Tailwind cannot know ahead of time). Any others should be justified or converted.

```bash
grep -rn "style={{" frontend/src
```

---

## Gate 3 — SSR safety

Client components still render once on the server. Browser globals read during render crash
the build or cause hydration mismatches.

```bash
# Every hit must be inside a useEffect, an event handler, or guarded — never in a
# render path or a useState initializer.
grep -rn "localStorage\|window\.\|document\.\|navigator\." frontend/src --include='*.tsx'
```

Known-safe patterns already in place, for comparison:

- `Header.tsx` reads `localStorage` in an effect, not in the `useState` initializer.
- `X402Preview.tsx` resolves `window.location.origin` in an effect.
- `Input.tsx` uses `useId()`, **not** `Math.random()`, so server and client agree.

A `typeof window !== 'undefined'` guard is **not** an acceptable fix in a render path — it
renders one value on the server and another on the client, which is a hydration mismatch.

---

## Gate 4 — Boot both servers

```bash
npm run dev            # backend :4402, frontend :5173
```

The backend must print, with **no `Warning:` lines**:

```
Spigot running on port 4402
Facilitator ready: https://facilitator.goplausible.xyz covers algorand:…
Operations (funds wallets): … — ready
Settlement (receives payments): … — ready
Custody (holds user credits): … — ready
Vendor liability … USDC against … held
User credits outstanding … USDC against … held
```

**Any `Warning:` line is a real misconfiguration.** The solvency lines are the important
ones: if either says an account is _short_, the platform owes more than it holds — stop and
investigate before taking payments.

---

## Gate 5 — Routes and rewrites (read-only)

```bash
for p in "/" "/onboarding" "/profile" "/test/x" "/dashboard/abc" "/dashboard/abc/settings"; do
  printf "%-30s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:5173$p")"
done
# all 200

# The rewrites must reach Express through the Next origin.
curl -s http://localhost:5173/api/health
# {"status":"ok","network":"testnet","usdcAssetId":10458941,"facilitator":"up"}

curl -s http://localhost:5173/x402/does-not-exist/foo
# {"error":"API not found or not published"}   <- proves it reached the gateway
```

If `/api/health` fails but `http://localhost:4402/api/health` works, the **rewrite** is
broken, not the backend. Check `BACKEND_ORIGIN` and `next.config.ts`.

---

## Gate 6 — Session cookie survives the rewrite ⚠️ mutates state

This is the gate that catches the single most damaging misconfiguration: the browser talking
to the backend cross-origin, which silently drops the `SameSite=Lax` session cookie. Sign-in
appears to succeed and every later request comes back unauthenticated.

**Use a throwaway account, never a real user's email.** With `RESEND_API_KEY` unset the code
prints to the backend console instead of being emailed.

```bash
curl -sS -c jar.txt -H 'Content-Type: application/json' \
  -X POST http://localhost:5173/api/auth/otp -d '{"email":"dev@example.com"}'
# {"sent":true,"channel":"console",...}

# read the 6-digit code from the backend console, then:
curl -sS -b jar.txt -c jar.txt -H 'Content-Type: application/json' \
  -X POST http://localhost:5173/api/auth/otp/verify \
  -d '{"email":"dev@example.com","code":"<CODE>"}'

grep x402_session jar.txt          # the cookie must be stored
curl -sS -b jar.txt http://localhost:5173/api/auth/me    # must return the user, not 401
```

**Clean up afterwards** — do not leave a live 30-day session lying around:

```bash
curl -sS -b jar.txt -X POST http://localhost:5173/api/auth/logout && rm -f jar.txt
```

---

## Gate 7 — Security sweep

Adapted from the `vibecoder-review` OWASP checklist. All of these should return nothing.

```bash
# Hardcoded credentials
grep -rnE "(mnemonic|api_key|secret|password|token)\s*[:=]\s*['\"][A-Za-z0-9+/=_-]{16,}" \
  backend/src frontend/src cli --include='*.ts' --include='*.tsx' --include='*.mjs' \
  | grep -v process.env | grep -v STORAGE_KEY

# Server secrets leaking into the browser bundle. Matches inside node_modules code
# (algokit's *_MNEMONIC env lookup, use-wallet's WalletId.MNEMONIC enum) are false
# positives — confirm any hit is a NAME in library code, never a VALUE.
grep -rlE "MNEMONIC|SESSION_SECRET|MASTER_ENCRYPTION_KEY|ADMIN_TOKEN" frontend/.next/static

# SQL built by concatenation or interpolation
grep -rnE "prepare\(\s*[\`'\"].*\\\$\{|prepare\(.*\+ " backend/src --include='*.ts'
#   Two hits are expected and safe — migrations.ts PRAGMA and connection.ts Turso sync.
#   Both take table names from code constants, never from a request.

# Code execution and XSS
grep -rnE "\beval\(|new Function\(|child_process|execSync" backend/src frontend/src cli
grep -rn "dangerouslySetInnerHTML\|innerHTML" frontend/src
```

### Invariants that must stay true

These are properties the code currently has. If a change breaks one, that is a security
regression regardless of whether anything else still passes.

| Invariant                                                                                     | Where                                   | Why it matters                                                                                 |
| --------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Credit is **debited before** any on-chain spend, atomically                                   | `routes/consume.ts`                     | Concurrent calls would otherwise all pass a balance check and custody pays for uncharged calls |
| Payment requirements are **rebuilt server-side**, never taken from the client                 | `routes/credits.ts`, `services/x402.ts` | A client could otherwise claim a $50 tier having signed $1                                     |
| Replay guard on `tx_id` **and** `payment_hash`, both UNIQUE                                   | `routes/gateway.ts`                     | One payment must not buy two calls                                                             |
| Dashboard queries scope to the **authenticated** publisher, not the URL param                 | `routes/dashboard.ts`                   | IDOR — reading another publisher's revenue                                                     |
| The onramp webhook **fails closed** without its secret, and is bounded by `MAX_RECHARGE_USDC` | `routes/credits.ts`                     | It mints credit from an external caller                                                        |
| Signing keys never reach an HTTP response; only `vault.ts` encrypts/decrypts                  | `services/vault.ts`, `wallet.ts`        | Custody                                                                                        |
| Publisher upstream credentials are encrypted at rest and withheld from public API views       | `routes/apis.ts`                        | Leaking them lets anyone bypass the gateway for free                                           |
| `BLOCKED_HEADERS` strips `authorization`/`cookie`/`x-api-key` before proxying upstream        | `services/proxy.ts`                     | Consumer credentials leaking to third-party publishers                                         |

---

## Gate 8 — Dependencies

```bash
npm audit --omit=dev
npm outdated
```

Note the pinned constraint: **ESLint is held at 9.x on purpose.** `eslint-config-next`
bundles `eslint-plugin-react@7.37.5`, the newest published, which is not ESLint 10
compatible — it throws `contextOrFilename.getFilename is not a function`. Retry ESLint 10
only after that plugin ships a fix.

---

## Known debt (expected to appear — not regressions)

| Item                                 | Count | Notes                                                                                                                                                                                                                                                  |
| ------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@typescript-eslint/no-explicit-any` | 0     | **Cleared.** DB rows are typed at the query via `prepare<BindParameters, Result>`; thrown values go through `errorMessage`/`errorField`; open payloads are `unknown` and narrowed. Rule is now `error`.                                                |
| `react-hooks/exhaustive-deps`        | 0     | **Cleared.** `SchemaValidation.tsx` memoises `data.endpoints                                                                                                                                                                                           |     | []`, which previously reallocated every render. |
| `react-hooks/set-state-in-effect`    | off   | Every violation was mount-time data loading. The rule's preferred fix (Server Components) is unavailable: these views sit behind an httpOnly cookie and render wallet adapters needing `window`. Revisit if the marketplace moves to server rendering. |
| Paid call not covered here           | —     | Gate 6 stops at authentication. Exercising a real paid call settles an actual on-chain transaction and spends credit, so it is deliberately manual.                                                                                                    |

---

## Quick reference

```bash
npm run verify      # format:check + lint + typecheck + build
npm run lint        # 0 errors expected
npm run format      # rewrite files to Prettier style
npm run dev         # both servers
```
