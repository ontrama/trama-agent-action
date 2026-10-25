# Local GitHub stand-in (development only)

Lets Trama's GitHub App code run on one machine for agent runs: the API's guided setup (workflow PR, public key,
secrets) and the agent's PRs talk to this server instead of api.github.com. Nothing leaves the machine.

- Answers the installation token and permissions (`MISSING_PERMISSIONS=contents,secrets` to see the "accept the new
  permissions" state), the repositories (`REPOS=owner/name:<id>,…`, default `local/trama-agent-sandbox:local-1`), the
  workflow (the PR that adds it is "merged" `AUTO_MERGE_SECONDS` after it opens, default 15), pull requests, the Actions
  public key and secrets.
- Secrets are real libsodium sealed boxes: the server opens them with its key and writes name → value to
  `SECRETS_FILE`, which the local executor reads (`AGENT_RUNS_LOCAL_SECRETS_FILE`). Values `local` and `fake:*` mean
  what they mean in `AGENT_RUNS_LOCAL_SECRETS` (this machine's Claude login; simulated outcomes).
- State is in memory: restart it to start over.

```sh
cd dev/fake-github && npm install
SECRETS_FILE=$PWD/local-secrets.json PORT=8790 node server.mjs
```

The API then needs `GITHUB_API_URL=http://127.0.0.1:8790`, `GITHUB_APP_ID=1`, `GITHUB_APP_CLIENT_ID=local-dev`,
`GITHUB_APP_PRIVATE_KEY` (any RSA key: `openssl genrsa 2048`), and the workspace's GitHub connection row with an
installation id and the repository row with the same id as in `REPOS`. `node seal.mjs <base64 key> <value>` seals a
value like the browser does. See trama `docs/AGENT_RUNS.md`, "Running it locally".
