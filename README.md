# trama-agent-action

Trama's GitHub action for **agent runs**: a Trama workspace admin sends a task to Claude Code, which works on it in
the workspace's own GitHub Actions and opens a pull request that Trama links to the task. Claude never runs on Trama's
servers, and the Claude token never reaches Trama.

Two composite steps go around [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action):

- **`start`** proves to Trama that the job is the repository's own `trama-agent.yml` (GitHub OIDC), gets the brief and
  a short-lived run token, creates the run branch and hands Claude its prompt and arguments;
- **`finish`** (`if: always()`) commits and pushes Claude's work and reports the outcome to Trama, once; Trama then
  opens the pull request with its GitHub App, so the repository's CI runs on it. On a plan limit, rate limit or failed
  login, Trama moves the run to the next Claude account, which continues from the pushed branch.

Plus `local/run.mjs`, which plays the same workflow on a developer's machine (Trama's local mode). Node 20+, no
dependencies. The contract with Trama is `docs/AGENT_RUNS.md` in the `trama` repository.

## Set up a repository

In Trama, **Workspace settings → Agents → Connect Claude** does it for you:

1. **Workflow:** "Add it" opens a pull request that adds [`templates/trama-agent.yml`](templates/trama-agent.yml) as
   `.github/workflows/trama-agent.yml`; merge it. Trama dispatches the workflow by that name.
2. **Claude account:** run `claude setup-token` (Claude Pro or Max) and paste the token. Your browser encrypts it with
   the repository's Actions public key and Trama stores it as the secret named like the account (`TRAMA_` +
   `A–Z 0–9 _`, e.g. `TRAMA_CLAUDE_MAX_JP`); Trama never sees the token.

The Trama GitHub App needs read and write on **Actions, Contents, Workflows, Pull requests and Secrets** (accept it
when GitHub asks; the Agents page links there while one is missing).

By hand instead: copy the template to `.github/workflows/trama-agent.yml` on the default branch, and add each token as
a repository or organization Actions secret with the account's name.

The workflow lets Claude edit files and run read-only and committing `git` commands. To let it run your tests, append
allowed tools in the workflow (the action merges repeated `--allowedTools`):

```yaml
claude_args: |
  ${{ steps.trama.outputs.claude_args }}
  --allowedTools "Bash(npm test:*),Bash(npm run lint:*)"
```

## How a run goes

```
Trama API ──workflow_dispatch (attempt_id, issue_key, secret_name, branch, mode, api_url …)──▶ trama-agent.yml
  start    ── GitHub OIDC token (audience = api_url) ──▶ POST {api_url}/agent_attempts/{id}/start
           ◀── brief, branches, PR title/footer, run token (masked), mcp_url
           git: trama-agent[bot] identity; branch <key>-agent-<run> from origin/<base>, or the pushed branch to continue
  claude   claude-code-action with claude_code_oauth_token: secrets[secret_name], the prompt, and claude_args:
           Trama's MCP server (mcp_url, Authorization: Bearer <run token>), --permission-mode acceptEdits,
           --allowedTools Edit,MultiEdit,Write,NotebookEdit,TodoWrite,Bash(git status|diff|log|show|add|commit|rm|mv|restore:*),Bash(ls:*),Bash(pwd),mcp__trama
  finish   reads $RUNNER_TEMP/claude-execution-output.json → commit leftovers, push, open the PR
           ──▶ POST {api_url}/agent_attempts/{id}/report (run token; Trama revokes it on receipt)
```

### Inputs

`start`:

| Input | |
|---|---|
| `attempt_id`, `api_url` | From the workflow inputs. `api_url` is also the OIDC audience (override with `oidc_audience`). |
| `secret_name` | Must match `^TRAMA_[A-Z0-9_]+$` (≤ 100), checked before anything else, so the workflow can't be used to hand Claude another secret. |
| `secret_present` | `${{ secrets[inputs.secret_name] != '' }}`. When false, start reports `failed` / `secret_missing` right away and stops; finish won't report again. |
| `mode` | `run` or `check` (Trama's start response wins). |
| `issue_key`, `base_branch`, `branch` | Fallbacks when Trama's answer lacks them. |

Outputs: `prompt` (Trama's brief plus a short "How this run works"), `prompt_file` (`$RUNNER_TEMP/trama/brief.md`),
`claude_args`, `mcp_config_file` (`$RUNNER_TEMP/trama/mcp.json`, 0600), `mode`, `branch`, `base_branch`,
`continue_from_branch`, `attempt_id`, `run_id`. State for finish goes to `$RUNNER_TEMP/trama/state.json` (0600).

`finish`: `execution_file` and `claude_outcome` (the Claude step's `execution_file` output and `outcome`), `job_status`
(`${{ job.status }}`), `timeout_minutes` (the job's, to tell a timeout from a cancellation), `github_token` (default
the job token), `open_pull_request` (`false` in the template: push and let Trama open the PR).

### What finish does

| Claude | Git | Report |
|---|---|---|
| succeeded, commits ahead of the base | commits leftovers as `<KEY>: <first line of Claude's summary>` and pushes | `succeeded` + `branch_pushed` and `pull_request` (title from Trama, body = Claude's summary + Trama's footer), and Trama opens the PR. With `open_pull_request: true`, finish opens it with the job token instead (an open PR for the branch is reused) and reports `pull_request_url` |
| succeeded, nothing ahead of the base | — | `succeeded` + `no_changes: true` |
| failed (limit, login, error) | commits leftovers as `WIP <KEY>: attempt <n> stopped` and pushes when the branch has commits | `failed` + `wip_pushed`, the end of Claude's output (≤ 8 KB) as `error_text`, and from the execution file `error_type` (`usage_limit_reached`, `rate_limit`, `authentication_failed`, `error_max_turns`, …), `api_error_status`, `resets_at` (ISO 8601) |
| cancelled / hit `timeout-minutes` | WIP as above | `cancelled` / `timeout` |
| check mode | — | the outcome only |

Every report carries `result_text`, `usage` (`input_tokens` = input + cache writes + cache reads, `output_tokens`,
`cost_usd`, `duration_ms`, `num_turns`, plus `cache_read_input_tokens`, `cache_creation_input_tokens`) and
`session_id`. With `open_pull_request: true`, a PR GitHub refuses (the repository doesn't allow GitHub Actions to
create pull requests) is reported as `failed` / `pull_request_failed` with the branch pushed.

### Tokens

- The **Claude token** stays a GitHub secret: only claude-code-action reads it (`secrets[inputs.secret_name]`); no
  secret travels in the dispatch inputs, only its name.
- The **OIDC token** proves the repository, workflow and run to Trama; it's masked and only sent to `api_url`.
- The **run token** (`lxt_at_…`, 3 h) is masked as soon as it arrives, lives in 0600 files and in `claude_args`
  (masked), and is sent only to Trama's API and MCP server. It reaches the run's task only, and Trama revokes it when
  finish reports. The scripts never print it; the tests check that.

Claude's own commits are authored `claude[bot]` (claude-code-action's git setup); the commits finish makes are
`trama-agent[bot]`.

### Known limits

- With `open_pull_request: true`, the PR is opened with `GITHUB_TOKEN`, which doesn't trigger other workflows (GitHub's
  rule), and the repository must allow GitHub Actions to create pull requests. The template leaves the PR to Trama.
- `GITHUB_TOKEN` can't push changes to `.github/workflows/*`; such a push fails and is reported.
- A job cancelled within 3 minutes of `timeout-minutes` is reported as `timeout`.

## Local mode

For development (Trama's API with `AGENT_RUNS_DISPATCH=local`), the API runs `node local/run.mjs` instead of
dispatching the workflow. It clones the repository into a temp dir with `gh repo clone` (the machine's `gh` login),
fakes the runner environment (`RUNNER_TEMP`, `GITHUB_OUTPUT`, `GITHUB_TOKEN` from `gh auth token`), and runs
`scripts/start.mjs`, Claude and `scripts/finish.mjs` — the same scripts as the action.

| Variable | |
|---|---|
| `TRAMA_LOCAL_INPUTS` | JSON of the workflow inputs (`attempt_id`, `issue_key`, `provider`, `kind`, `secret_name`, `base_branch`, `branch`, `mode`, `api_url`) |
| `TRAMA_LOCAL_OIDC_TOKEN` | The token the API signed in place of GitHub's OIDC token |
| `TRAMA_LOCAL_REPOSITORY` | `owner/name` |
| `TRAMA_LOCAL_LOG` | Optional file the log is appended to (secrets removed) |
| `AGENT_RUNS_LOCAL_SECRETS` | JSON object, secret name → value (below) |
| `TRAMA_LOCAL_CLONE_FROM` | Optional path or URL to `git clone` instead of `gh repo clone` (tests) |
| `TRAMA_LOCAL_GITHUB_TOKEN`, `TRAMA_LOCAL_GITHUB_API_URL` | Optional, instead of `gh auth token` and `https://api.github.com` |
| `TRAMA_LOCAL_CLAUDE_BIN`, `TRAMA_LOCAL_TIMEOUT_MINUTES`, `TRAMA_LOCAL_KEEP=1` | Optional: the claude binary, the time limit (60), keep the temp dir |
| `AGENT_RUNS_LOCAL_SECRETS_FILE` | Optional: a JSON file of more secrets (name → value), e.g. what a local GitHub stand-in stored through Trama's guided setup |
| `TRAMA_LOCAL_OPEN_PULL_REQUEST=false` | Optional: push the branch and let Trama open the PR (as the template does on GitHub) |
| `TRAMA_LOCAL_EXTRA_TOOLS` | Optional, comma-separated: more commands Claude may run, e.g. `Bash(npm test:*),Bash(node --test:*)`. They run the repository's own scripts on this machine, so none by default |

Secret values:

- `"local"`: Claude runs with this machine's own login (no token is set);
- `"fake:success"`, `"fake:plan_limit"`, `"fake:rate_limited"`, `"fake:login_failed"`: Claude isn't called; the
  execution file holds the messages the CLI prints for that outcome (`You've hit your session limit · resets 10pm
  (UTC)`, `API Error: 429 rate_limit_error`, `API Error: 401 Invalid API key · Please run /login`).
  `fake:success` commits a line to `TRAMA_AGENT_LOG.md` (push and PR path); `fake:plan_limit` leaves an uncommitted
  line (WIP push, then the next account continues from the branch);
- anything else: passed to Claude as `CLAUDE_CODE_OAUTH_TOKEN`.

Claude runs as `claude -p --output-format stream-json --verbose --strict-mcp-config --setting-sources project
--mcp-config <mcp.json> --permission-mode acceptEdits --allowedTools <git commands>,mcp__trama` with the prompt on
stdin, in the clone, with a minimal environment (none of the API's variables). File edits are auto-accepted inside the
clone only; there is no `--dangerously-skip-permissions`. Its stream is saved in the execution-file format
claude-code-action uses. SIGTERM cancels Claude and finish still reports `cancelled`. The exit code is 0 only when the
attempt succeeded.

```sh
TRAMA_LOCAL_INPUTS='{"attempt_id":"30","issue_key":"BOARDP-1713","provider":"claude","kind":"oauth_token","secret_name":"TRAMA_DEV","base_branch":"main","branch":"boardp-1713-agent-12","mode":"run","api_url":"http://localhost:3000"}' \
TRAMA_LOCAL_OIDC_TOKEN=… TRAMA_LOCAL_REPOSITORY=acme/web \
AGENT_RUNS_LOCAL_SECRETS='{"TRAMA_DEV":"fake:success"}' \
node local/run.mjs
```

## Development

```sh
npm test   # node --test: start/finish against a stub API and GitHub in temp repos with a bare origin; local/run.mjs with fake outcomes and a fake claude
```

`scripts/lib.mjs` (runner protocol, HTTP, git), `scripts/execution.mjs` (reading Claude's execution file),
`scripts/start.mjs`, `scripts/finish.mjs`, `local/run.mjs`, `local/fake.mjs`. Release by moving the `v1` tag.
