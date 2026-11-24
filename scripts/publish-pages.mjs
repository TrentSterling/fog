// A GITHUB_TOKEN push does not trigger a Pages build. Explicitly request one,
// wait for the mirrored commit, then verify the public bytes independently.
import { appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = 'https://api.github.com';
export const publicRoot = 'https://tront.xyz/fog/';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function repositoryPath(repository) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository || '')) {
    throw new Error('A valid GITHUB_REPOSITORY owner/name is required.');
  }
  return `/repos/${repository}`;
}

// Do not include response bodies, credentials, or fetch exceptions in logs.
async function request(url, { fetchImpl, headers, method = 'GET', timeoutMs, binary = false }) {
  try {
    const response = await fetchImpl(url, {
      method, headers, redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, value: null };
    }
    const value = binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
    return { status: response.status, value };
  } catch {
    throw new Error('A publication request failed, timed out, redirected, or returned an invalid response.');
  }
}

function apiRequest(repository, token, path, options) {
  if (typeof token !== 'string' || !token) throw new Error('GH_TOKEN is required for the Pages API.');
  // Construct URLs locally, never from an authenticated API response or redirect.
  const url = apiRoot + repositoryPath(repository) + path;
  return request(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  });
}

export async function getPagesConfiguration({ repository, token, fetchImpl = fetch, timeoutMs = 20_000 }) {
  const result = await apiRequest(repository, token, '/pages', { fetchImpl, timeoutMs });
  if (![200, 403, 404].includes(result.status)) throw new Error(`Pages configuration lookup failed (HTTP ${result.status}).`);
  return { status: result.status, config: result.value };
}

export function usesPublicationBranch(config) {
  return config?.build_type === 'legacy' && config.source?.branch === 'gh-pages' && config.source?.path === '/';
}

export function requirePublicationBranch({ status, config }) {
  if (status !== 200) throw new Error(`Cannot confirm the existing Pages source (HTTP ${status}); no Pages settings were changed.`);
  if (config?.build_type === 'workflow') {
    throw new Error('Pages uses GitHub Actions. The branch publisher will not change its source; use the Build and publish FogLab deployment workflow.');
  }
  if (!usesPublicationBranch(config)) {
    throw new Error('This publisher requires the existing legacy gh-pages branch at /. The configured Pages source was not changed.');
  }
}

function validateManifest(manifest) {
  if (manifest?.name !== 'FogLab' || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(manifest.version)
    || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') || !Number.isSafeInteger(manifest.htmlBytes) || manifest.htmlBytes <= 0) {
    throw new Error('dist/build.json does not contain a valid FogLab version, SHA-256, and HTML byte count.');
  }
}

export async function publishPages({
  repository, token, expectedCommit, manifest, fetchImpl = fetch,
  now = Date.now, sleep = delay, timeoutMs = 10 * 60_000,
  requestTimeoutMs = 20_000, pollIntervalMs = 12_000, onProgress = console.log
}) {
  repositoryPath(repository);
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || '')) throw new Error('PAGES_COMMIT must be the full mirrored gh-pages commit SHA.');
  validateManifest(manifest);
  for (const value of [timeoutMs, requestTimeoutMs, pollIntervalMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Publication timeouts must be positive finite values.');
  }
  const deadline = now() + timeoutMs;
  let lastState = 'Waiting for the Pages build.';
  const remaining = () => {
    const left = deadline - now();
    if (left <= 0) throw new Error(`Pages publication timed out. ${lastState}`);
    return left;
  };
  const options = () => ({ fetchImpl, timeoutMs: Math.min(requestTimeoutMs, remaining()) });
  const pause = () => sleep(Math.min(pollIntervalMs, remaining()));
  requirePublicationBranch(await getPagesConfiguration({ repository, token, ...options() }));
  let existing = null;
  try {
    existing = await apiRequest(repository, token, '/pages/builds/latest', options());
  } catch { /* A build can still be requested when this initial lookup fails. */ }
  const reuse = existing?.status === 200 && existing.value?.commit === expectedCommit && ['queued', 'building', 'built'].includes(existing.value.status);
  // A rerun can request another build of the same commit after an old failure.
  // Do not mistake that previous failure for the newly requested build.
  let previousFailure = existing?.status === 200 && existing.value?.commit === expectedCommit && existing.value.status === 'errored' ? existing.value : null;
  let nextBuild = reuse ? existing : null;
  if (reuse) {
    onProgress(`Using the existing Pages build for gh-pages commit ${expectedCommit}.`);
  } else {
    const requested = await apiRequest(repository, token, '/pages/builds', { ...options(), method: 'POST' });
    if (requested.status !== 201) throw new Error(`Pages build request failed (HTTP ${requested.status}); the mirrored assets remain saved on gh-pages.`);
    onProgress(`Requested Pages build for gh-pages commit ${expectedCommit}.`);
  }

  for (;;) {
    remaining();
    let latest;
    try {
      latest = nextBuild || await apiRequest(repository, token, '/pages/builds/latest', options());
      nextBuild = null;
    } catch {
      lastState = 'The latest Pages build could not be read.';
      await pause();
      continue;
    }
    if (latest.status === 200) {
      const build = latest.value;
      if (build?.commit === expectedCommit && build.status === 'built') break;
      if (build?.commit === expectedCommit && build.status === 'errored') {
        const oldFailure = previousFailure && build.url === previousFailure.url && build.created_at === previousFailure.created_at;
        if (!oldFailure) throw new Error(`Pages reported an errored build for ${expectedCommit}; inspect the repository Pages build logs.`);
      } else if (build?.commit === expectedCommit) {
        previousFailure = null;
      }
      lastState = build?.commit === expectedCommit ? 'The expected Pages commit is still queued or building.' : 'Pages has not reported a completed build for the expected commit.';
    } else if ([404, 408, 429].includes(latest.status) || latest.status >= 500) {
      lastState = `The latest Pages build is temporarily unavailable (HTTP ${latest.status}).`;
    } else {
      throw new Error(`Reading the latest Pages build failed (HTTP ${latest.status}).`);
    }
    await pause();
  }

  onProgress('The expected Pages commit is built. Verifying the public manifest and both HTML files.');
  for (;;) {
    remaining();
    // Public requests deliberately have no Authorization or other API headers.
    // Each attempt gets a fresh cache key, including the publication commit.
    const query = `?commit=${expectedCommit}&check=${Math.floor(now())}`;
    try {
      const live = await request(publicRoot + 'build.json' + query, options());
      if (live.status !== 200 || live.value?.version !== manifest.version || live.value?.sha256 !== manifest.sha256 || live.value?.htmlBytes !== manifest.htmlBytes) {
        lastState = 'The public build manifest does not match the verified release yet.';
      } else {
        const files = ['index.html', 'FogLab.html'];
        const results = await Promise.all(files.map(file => request(publicRoot + file + query, { ...options(), binary: true })));
        const matching = results.every(result => result.status === 200 && result.value.length === manifest.htmlBytes && sha256(result.value) === manifest.sha256);
        if (matching) {
          onProgress(`Verified FogLab ${manifest.version}: both public HTML files match SHA-256 ${manifest.sha256}.`);
          return { version: manifest.version, commit: expectedCommit, sha256: manifest.sha256, url: publicRoot };
        }
        lastState = 'The public HTML files do not both match the verified SHA-256 yet.';
      }
    } catch {
      lastState = 'The public release could not be fetched and verified yet.';
    }
    await pause();
  }
}

async function main() {
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token, PAGES_COMMIT: expectedCommit, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } = process.env;
  const manifest = JSON.parse(await readFile(resolve(root, 'dist/build.json'), 'utf8'));
  const result = await publishPages({ repository, token, expectedCommit, manifest });
  if (output) await appendFile(output, `published=true\npages_commit=${result.commit}\nurl=${result.url}\n`);
  if (summary) await appendFile(summary, `### FogLab ${result.version} is published and verified\n\nPages built gh-pages commit \`${result.commit}\`. The public [demo](${result.url}) and [offline HTML](${result.url}FogLab.html) both match the verified build SHA-256 \`${result.sha256}\`.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    console.error(error.message);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Pages publication was not verified\n\n${error.message}\n`);
    process.exitCode = 1;
  });
}
