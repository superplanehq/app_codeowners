# PR Risk Review

[![Launch in SuperPlane](http://superplane.com/badges/launch-in-superplane.svg)](https://app.superplane.com/install?repo=github.com/superplanehq/app_codeowners)

**LLM pull request risk review** on GitHub — checkout the PR on a large runner, score risk with Claude (Anthropic API), OpenAI Codex, or Amazon Bedrock, optionally enforce **`codeowners.yml`** owner approval, publish status, and upsert a single PR comment with the full review.

Built with [SuperPlane](https://superplane.com).

## How it works

1. **Review PR** (`runnerJS`, host on `e1-large-amd64`) — clone repo, checkout PR head, read `codeowners.yml`, build diff, call the configured LLM (fetch + optional Bedrock SDK)
2. **Evaluate PR risk** (`runnerJS`) — merge the LLM JSON with GitHub owner approvals from `codeowners.yml` and upsert one PR comment
3. Publish **PR Risk Review** commit status, optionally request reviewers, and on the **first** review post a **Discord** message

### Pass / fail

| Condition | Required for pass |
|---|---|
| LLM review (`approved: true`) | Always |
| `codeowners.yml` owner rules | When rules exist — covered files need approving GitHub reviews |

## LLM providers

Set **`LLM_PROVIDER`** on the **Review PR** node to one of:

| Provider | `LLM_PROVIDER` | Credentials | Default model |
|---|---|---|---|
| Anthropic (Claude) | `anthropic` | `ANTHROPIC_API_KEY` secret | `claude-opus-4-8` |
| Amazon Bedrock | `bedrock` | **`AWS_REGION`** + model access; optional secrets **`AWS_ACCESS_KEY_ID`**, **`AWS_SECRET_ACCESS_KEY`**, **`AWS_SESSION_TOKEN`** (omit if runner has an IAM role) | `anthropic.claude-opus-4-8` |
| OpenAI Codex | `codex` | `OPENAI_API_KEY` secret | `gpt-5.3-codex` |

Override models with **`ANTHROPIC_MODEL`**, **`BEDROCK_MODEL_ID`**, or **`CODEX_MODEL`**. Any provider accepts a generic **`LLM_MODEL`** override.

If `LLM_PROVIDER` is unset, the script picks the first available credential: Anthropic API key → OpenAI API key → AWS region.

## Prerequisites

- [SuperPlane](https://superplane.com) account
- GitHub integration on triggers, status, and reviewer nodes
- Fleet runner with **`e1-large-amd64`** for **Review PR**; **`git`** and **Node.js** on the runner
- One LLM backend (Anthropic API key, OpenAI API key, or Bedrock access)
- Optional: `codeowners.yml` on `main` / `master`

## Setup

1. **Connect GitHub** on trigger, status, and reviewer nodes.
2. **Connect Discord** on **Discord review posted** and select the channel.
3. On **Review PR**, set **`LLM_PROVIDER`** and add the matching node secrets:
   - **`anthropic`** — `ANTHROPIC_API_KEY`
   - **`codex`** — `OPENAI_API_KEY`
   - **`bedrock`** — enable Claude Opus 4.8 in Bedrock; set **`AWS_REGION`**. Add **`AWS_ACCESS_KEY_ID`** / **`AWS_SECRET_ACCESS_KEY`** secrets unless the runner uses an IAM role. Optional **`AWS_SESSION_TOKEN`** for temporary credentials.
4. Add **`GITHUB_TOKEN`** on **Review PR** and **Evaluate PR risk** for private repos (recommended for all repos).
5. Optional: add `codeowners.yml` for owner rules and `compliance_reviewers`.
6. Optional: branch protection on the **PR Risk Review** status check.

Setup on **Review PR**: `npm install --no-save @aws-sdk/client-bedrock-runtime` (Bedrock only; Anthropic and OpenAI use `fetch`).

Setup on **Evaluate PR risk**: `npm install --no-save js-yaml`

### Discord (first review only)

On the first review for a PR (when the GitHub comment is created, not updated on re-check), a message is posted to Discord:

`[PR title](https://github.com/owner/repo/pull/123) - author - Risk: 9/100`

Connect the **Discord review posted** node to your Discord integration and pick a channel.

## `codeowners.yml`

See inline docs in `console.yaml` — `groups`, `rules`, `compliance_reviewers`.

Without it, the LLM still reviews the diff; only owner enforcement is skipped.

## Source layout

| File | Role |
|---|---|
| `scripts/review_pr.js` | Checkout + multi-provider LLM call |
| `scripts/merge_check.js` | Owner policy + merge + upsert PR comment |
| `canvas.yaml` | Embedded workflow |

## License

MIT
