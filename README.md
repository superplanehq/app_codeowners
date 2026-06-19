# Code Owners

[![Launch in SuperPlane](http://superplane.com/badges/launch-in-superplane.svg)](https://app.superplane.com/install?repo=github.com/superplanehq/app_codeowners)

Enforce **`codeowners.yml` approval** on GitHub pull requests — request reviewers when a PR opens, publish a **Code Owners** commit status, and track check results in the console.

Built with [SuperPlane](https://superplane.com).

## How it works

1. **On pull request** — listen for `opened`, `synchronize`, and `reopened` events on a selected repository
2. **On PR review** — re-check when a review is submitted
3. **Check code owners** — read `codeowners.yml` from `main` or `master`, map changed files to owners and groups, and verify each covered file is approved
4. **Request reviewers** — when a pull request is opened, add reviewers from `codeowners.yml` for the changed files (author and existing approvers are skipped)
5. **Enforce** — publish a **Code Owners** commit status (success or failure) on the PR head commit
6. **Console** — recent checks table backed by the `codeownersChecks` memory namespace

## Prerequisites

- [SuperPlane](https://superplane.com) account
- GitHub integration connected to the target repository
- `codeowners.yml` at the repository root on `main` or `master`

## Setup

1. **Add `codeowners.yml`** to your repository root on `main` or `master`.
2. **Connect GitHub** — bind the integration on **On Pull Request**, **On PR Review**, **Add pull request reviewers**, and the status nodes. Select your repository on both triggers.
3. **Branch protection** — require the **Code Owners** status check before merging.
4. **Optional:** add a `GITHUB_TOKEN` secret on **Check code owners** for private repositories.

## `codeowners.yml` format

```yaml
groups:
  frontend-team:
    - alice
    - bob
  docs-team:
    - carol

rules:
  - pattern: "/src/**"
    self_approval: true
    owners:
      - "@frontend-team"
      - "@eve"
  - pattern: "/docs/**"
    self_approval: false
    owners:
      - "@docs-team"
```

- Patterns are matched from the **repository root** — use a leading `/` (for example, `/pkg/models/**`)
- The last matching rule wins
- `self_approval` defaults to `false`
- Groups are defined under `groups` with GitHub usernames; reference them in `owners` as `@group-name`
- Checks run only on pull requests into `main` or `master`

## `GITHUB_TOKEN` secret

Add a secret named `GITHUB_TOKEN` on the **Check code owners** node. It is used to read repository contents and pull request files from the GitHub API.

- **Private repositories:** required
- **Public repositories:** optional, but recommended to avoid unauthenticated API rate limits

### Fine-grained personal access token (recommended)

- **Repository access:** Only select repositories → choose the target repository
- **Repository permissions:**
  - **Contents:** Read
  - **Metadata:** Read
  - **Pull requests:** Read

## Customization

| Setting | Default |
|---|---|
| Policy file | `codeowners.yml` |
| Policy branch | `main` or `master` |
| Target branches | `main`, `master` |
| Status context | `Code Owners` |
| Memory namespace | `codeownersChecks` |
| Reviewer assignment | On `opened` only |

## License

MIT
