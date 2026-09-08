# AGENTS.md — read this first

**Any agent, any tool.** This file is the entry point. It is deliberately short: it tells you
where to look, not what to think.

Safe to create because `frontend/next.config.ts` sets `agentRules: false` — Next will not
overwrite it on dev startup.

---

## 1. Start here

```
Invoke the skill `x402-router`.
```

It reads your task, works out which flow it belongs to, and asks before entering one. If you
cannot invoke skills, read `.agents/skills/x402-router/SKILL.md` directly — it is plain markdown.

---

## 2. What this repo is

Spigot — a marketplace and publisher platform for paid APIs. Calls are metered per request and
settle in USDC on Arc Testnet. Publishers list endpoints and set pricing; consumers call them
without a wallet popup.

| Part    | Path       | Status                                                           |
| ------- | ---------- | ---------------------------------------------------------------- |
| Backend | `backend/` | **Verified working. Do not touch without explicit instruction.** |
| CLI     | `cli/`     | **Same.**                                                        |

_(Frontend is maintained separately in `../spigot-website`)_

---

## 3. The documents, and when each one matters

| File                                | Read it when                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `flow.md`                           | Always. §1–6 are the runtime flows; §8 data model; §9 external services        |
| `discuss.md`                        | Before changing a decision. Every judgement call and its rejected alternatives |
| `verify.md`                         | Before and after any large change. The gated runbook                           |
| `SECURITY.md`, `security-review.md` | Security work, or changing `scripts/security-review.sh`                        |
| `env.md`                            | Adding any environment variable                                                |
| `deploy.md`, `mainnet.md`           | Deployment only                                                                |
| `.agents/product-marketing.md`      | Any content, copy or SEO work                                                  |

---

## 4. Non-negotiables

These break the build or fail silently. They outrank every skill and every preference.

- **Route params and request bodies must be validated.**
- **Never assume something works because it compiled.** Run it

---

## 4a. Build what is asked, not what might be needed

**Do not add sections, variants, states or pages before they are asked for.** The user decides
where each part goes as the product is built, and says so at the time.

This applies especially to the design system: a component page gets the sections it has been
asked for. Matching another system's page structure section-for-section is not a reason to add
one — Geist's Button page has eleven sections because Vercel needed eleven, not because eleven
is correct.

Speculative structure looks like thoroughness and behaves like debt. It has to be reviewed,
maintained and kept truthful, and most of it is never used.

**If something looks missing, say so and stop.** Naming a gap costs a sentence; filling it
uninvited costs a review and often a revert.

## 5. The bar

After every meaningful change:

```bash
npm run verify              # format + lint + typecheck + build
scripts/security-review.sh
```

| Metric          | Must hold or improve |
| --------------- | -------------------- |
| Lint errors     | 0                    |
| Lint warnings   | 0                    |
| Security checks | 33/33                |
| Vulnerabilities | 0                    |

If warnings exceed 0, say so. Do not accept it silently.

`@typescript-eslint/no-explicit-any` is now **`error`**, not `warn` — see `eslint.config.mjs`.
A new `any` fails the build rather than adding to a count. If an upstream shape is genuinely
unknowable, model it as `unknown` and narrow it; do not disable the rule.

These are re-measured, not inherited. The table previously read 63 and 39/39 while the repo
actually produced 61 and 40/40 — a baseline set two warnings and one check too loose lets that
much regression through unnoticed. Re-measure when you change it.

---

## 6. Update docs in the same change

Not afterwards. `flow.md` §7 for structure changes, `discuss.md` appended for any judgement
call, `verify.md` if the baseline moves, `ui.md` for design decisions.
