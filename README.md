# PR Risk Review

[![Launch in SuperPlane](http://superplane.com/badges/launch-in-superplane.svg)](https://app.superplane.com/install?repo=github.com/superplanehq/app_codeowners)

**LLM pull request risk review** on GitHub — a [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/overview) assesses each PR, upserts a PR comment, optionally requests reviewers, and notifies Discord.

## Flow

1. **Assess PR Risk** (`claude.runAgent`) — Claude Managed Agent clones the repo, reviews the diff, returns structured JSON
2. **Format PR review** (`runnerJS`, tiny) — parse JSON, build comment body and Discord message
3. **Create/Update PR comment** — GitHub integration (posts as the integration bot)
4. **Record check** — saves results to the console table
5. **Discord review posted** — notification on completed review

## Prerequisites

- **Claude integration** with API key on SuperPlane
- A **Managed Agent** and **Environment** in Anthropic (for checkout + review)
- **GitHub integration** on triggers, reviewers, and comment nodes
- **`GITHUB_TOKEN`** secret (`app-codeowners`) injected into the agent session for private repos
- Optional: **Discord** integration on **Discord review posted**

## Setup

1. Create a Claude Managed Agent + environment that can clone GitHub repos and review PR diffs.
2. **Connect Claude** and bind it on **Assess PR Risk**.
3. **Connect GitHub** and bind the integration on trigger, reviewer, and comment nodes.
4. Add **`GITHUB_TOKEN`** to the `app-codeowners` secret (used by the agent via session secret injection).
5. Optional: **Connect Discord** on **Discord review posted** and pick a channel.

Checks run for PRs targeting **`main`** or **`master`** only (manual checks always run). Draft PRs are skipped until marked **ready for review** (or updated with a new push).

### Discord

`[Fix auth middleware](<https://github.com/acme/api/pull/42>) - alice - Risk 15/100 (low)`

## Risk score

Risk score (`0–100`) and level (`very low` / `low` / `medium` / `high` / `critical`) are shown in the PR comment, GitHub commit status, and console.

## Source layout

| File | Role |
|---|---|
| `scripts/format_review.js` | Parse Claude output, build comment fields |
| `canvas.yaml` | Embedded workflow |

## License

MIT
