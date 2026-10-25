// A stand-in for the GitHub API during local agent-run development: answers what Trama's GitHub App asks (installation
// token and permissions, repositories, the workflow PR, Actions secrets, the agent's PRs). Secrets are real libsodium
// sealed boxes, opened with this server's key and written to SECRETS_FILE for the local executor. The workflow PR is
// "merged" AUTO_MERGE_SECONDS after it opens. Local testing only; nothing leaves this machine.
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import sodium from 'libsodium-wrappers';

const PORT = Number(process.env.PORT || 8790);
const LOG = process.env.LOG || 'fake-gh.log';
const SECRETS_FILE = process.env.SECRETS_FILE || 'local-secrets.json';
const AUTO_MERGE_SECONDS = Number(process.env.AUTO_MERGE_SECONDS || 15);
const REPOS = (process.env.REPOS || 'local/trama-agent-sandbox:local-1').split(',').map((entry) => {
  const [fullName, id] = entry.split(':');
  return { fullName, id };
});
const WORKFLOW_PATH = '.github/workflows/trama-agent.yml';

await sodium.ready;
const keyPair = sodium.crypto_box_keypair();
const keyId = `local-${Date.now()}`;
const state = Object.fromEntries(REPOS.map((repo) => [repo.fullName, { files: {}, secrets: {}, pulls: [], branches: new Set(['main']) }]));
let nextPull = 1;

function secretsOnDisk() {
  try {
    return existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(data === undefined ? '' : JSON.stringify(data));
}

function log(line) {
  appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    const body = raw ? JSON.parse(raw) : {};
    log(`${req.method} ${path}${url.search} ${path.includes('/secrets/') ? '(sealed value hidden)' : raw.slice(0, 300)}`);
    let m;

    // The App ---------------------------------------------------------------------------------------------------
    if ((m = path.match(/^\/app\/installations\/([^/]+)\/access_tokens$/)) && req.method === 'POST') {
      return send(res, 201, { token: `local-installation-${m[1]}`, expires_at: new Date(Date.now() + 3600e3).toISOString() });
    }
    if ((m = path.match(/^\/app\/installations\/([^/]+)$/))) {
      const perms = { actions: 'write', contents: 'write', workflows: 'write', pull_requests: 'write', secrets: 'write', metadata: 'read' };
      for (const missing of (process.env.MISSING_PERMISSIONS || '').split(',').filter(Boolean)) perms[missing] = 'read';
      return send(res, 200, { id: m[1], html_url: `http://127.0.0.1:${PORT}/settings/installations/${m[1]}`, permissions: perms });
    }
    if (path === '/installation/repositories') {
      return send(res, 200, { total_count: REPOS.length, repositories: REPOS.map((r) => ({ id: r.id, full_name: r.fullName, html_url: null })) });
    }

    // Repositories ----------------------------------------------------------------------------------------------
    m = path.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!m || !state[m[1]]) return send(res, 404, { message: 'Not Found' });
    const repoName = m[1];
    const repo = state[repoName];
    const rest = m[2] || '';

    if (rest === '') return send(res, 200, { full_name: repoName, default_branch: 'main' });
    if (rest === `/actions/workflows/trama-agent.yml`) {
      return repo.files[`main:${WORKFLOW_PATH}`] ? send(res, 200, { id: 1, path: WORKFLOW_PATH, state: 'active' }) : send(res, 404, { message: 'Not Found' });
    }
    if ((m = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
      return repo.branches.has(m[1]) ? send(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha: `sha-${m[1]}` } }) : send(res, 404, { message: 'Not Found' });
    }
    if (rest === '/git/refs' && req.method === 'POST') {
      const branch = body.ref.replace('refs/heads/', '');
      if (repo.branches.has(branch)) return send(res, 422, { message: 'Reference already exists' });
      repo.branches.add(branch);
      return send(res, 201, { ref: body.ref });
    }
    if ((m = rest.match(/^\/contents\/(.+)$/))) {
      const branch = req.method === 'PUT' ? body.branch : url.searchParams.get('ref') || 'main';
      const key = `${branch}:${m[1]}`;
      if (req.method === 'PUT') {
        repo.files[key] = Buffer.from(body.content, 'base64').toString('utf8');
        return send(res, 201, { content: { path: m[1], sha: `file-${Date.now()}` } });
      }
      return repo.files[key] ? send(res, 200, { path: m[1], sha: 'file-sha' }) : send(res, 404, { message: 'Not Found' });
    }
    if (rest === '/pulls' && req.method === 'GET') {
      const head = url.searchParams.get('head');
      const open = repo.pulls.filter((pr) => pr.state === 'open' && (!head || `${repoName.split('/')[0]}:${pr.head.ref}` === head));
      return send(res, 200, open);
    }
    if (rest === '/pulls' && req.method === 'POST') {
      if (repo.pulls.some((pr) => pr.state === 'open' && pr.head.ref === body.head)) {
        return send(res, 422, { message: 'Validation Failed: A pull request already exists' });
      }
      const number = nextPull++;
      const pr = { number, state: 'open', title: body.title, head: { ref: body.head }, base: { ref: body.base }, body: body.body,
                   html_url: `https://github.com/${repoName}/pull/${number}` };
      repo.pulls.push(pr);
      if (body.head === 'trama/agent-workflow') {
        setTimeout(() => {
          pr.state = 'closed';
          pr.merged = true;
          repo.files[`main:${WORKFLOW_PATH}`] = repo.files[`trama/agent-workflow:${WORKFLOW_PATH}`];
          log(`auto-merged PR #${number} (the workflow is now on main)`);
        }, AUTO_MERGE_SECONDS * 1000);
      }
      return send(res, 201, pr);
    }
    if (rest === '/actions/secrets/public-key') {
      return send(res, 200, { key_id: keyId, key: sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL) });
    }
    if (rest === '/actions/secrets') {
      return send(res, 200, { total_count: Object.keys(repo.secrets).length, secrets: Object.keys(repo.secrets).map((name) => ({ name })) });
    }
    if (rest === '/actions/organization-secrets') return send(res, 404, { message: 'Not Found' });
    if ((m = rest.match(/^\/actions\/secrets\/([A-Za-z0-9_]+)$/)) && req.method === 'PUT') {
      if (body.key_id !== keyId) return send(res, 422, { message: 'Bad key_id' });
      let plain;
      try {
        const sealed = sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL);
        plain = sodium.to_string(sodium.crypto_box_seal_open(sealed, keyPair.publicKey, keyPair.privateKey));
      } catch {
        return send(res, 422, { message: 'The value is not a sealed box for this key' });
      }
      repo.secrets[m[1]] = true;
      const all = secretsOnDisk();
      all[m[1]] = plain;
      writeFileSync(SECRETS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
      log(`stored secret ${m[1]} (${plain.length} characters, opened with the sealed-box key)`);
      return send(res, 201);
    }
    return send(res, 404, { message: 'Not Found' });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`fake GitHub API on http://127.0.0.1:${PORT} (repos: ${REPOS.map((r) => r.fullName).join(', ')})`));
