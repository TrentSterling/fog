import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { publishPages, getPagesConfiguration, publicRoot } from '../scripts/publish-pages.mjs';
import { describePages } from '../scripts/pages-status.mjs';

const repository = 'TrentSterling/fog';
const token = 'test-secret-never-public';
const commit = 'a'.repeat(40), oldCommit = 'b'.repeat(40);
const html = Buffer.from('<!doctype html><title>FogLab</title>verified release');
const manifest = { name: 'FogLab', version: '0.4.0', htmlBytes: html.length, sha256: createHash('sha256').update(html).digest('hex') };
const config = { build_type: 'legacy', source: { branch: 'gh-pages', path: '/' } };
const build = (sha, status, id = 1) => ({ commit: sha, status, url: `https://api.github.com/repos/${repository}/pages/builds/${id}`, created_at: `2026-11-24T12:00:0${id}Z` });
const event = (path, value, status = 200, method = 'GET') => ({ path, value, status, method });
const publicSuccess = () => [event('build.json', manifest), event('index.html', html), event('FogLab.html', html)];

function harness(events, overrides = {}) {
  const calls = [], messages = [], pauses = [];
  let clock = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = events.shift();
    assert(next, `Unexpected request: ${options.method} ${url}`);
    const parsed = new URL(url);
    const api = next.path.startsWith('/pages');
    assert.equal(parsed.origin, api ? 'https://api.github.com' : 'https://tront.xyz');
    assert.equal(parsed.pathname, api ? `/repos/${repository}${next.path}` : `/fog/${next.path}`);
    assert.equal(options.method, next.method);
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    assert.equal(options.credentials, 'omit');
    if (api) {
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
    } else {
      assert.equal(options.headers, undefined, 'No API headers may reach the public site');
      assert.equal(parsed.searchParams.get('commit'), commit);
      assert(parsed.searchParams.has('check'));
    }
    if (next.error) throw next.error;
    if (next.invalidJSON) return new Response('invalid json', { status: 200 });
    return new Response(Buffer.isBuffer(next.value) ? next.value : JSON.stringify(next.value), { status: next.status });
  };
  const options = {
    repository, token, expectedCommit: commit, manifest, fetchImpl,
    now: () => clock, sleep: async ms => { pauses.push(ms); clock += ms; },
    timeoutMs: 100, requestTimeoutMs: 20, pollIntervalMs: 10,
    onProgress: message => messages.push(message), ...overrides
  };
  return { options, calls, messages, pauses, remaining: events, elapsed: () => clock };
}

test('publication waits for the exact commit and both served HTML hashes', async () => {
  const h = harness([
    event('/pages', config), event('/pages/builds/latest', build(oldCommit, 'built')),
    event('/pages/builds', { status: 'queued', url: 'https://untrusted.invalid/do-not-follow' }, 201, 'POST'),
    event('/pages/builds/latest', build(oldCommit, 'errored')),
    event('/pages/builds/latest', build(commit, 'queued')),
    event('/pages/builds/latest', build(commit, 'built')),
    event('build.json', { ...manifest, version: '0.3.0' }),
    event('build.json', manifest), event('index.html', html), event('FogLab.html', Buffer.from('stale download')),
    ...publicSuccess()
  ]);
  const result = await publishPages(h.options);
  assert.deepEqual(result, { version: manifest.version, commit, sha256: manifest.sha256, url: publicRoot });
  assert.equal(h.remaining.length, 0);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(h.pauses.length, 4);
  assert(h.messages.every(message => !message.includes(token)));
  const queries = h.calls.filter(call => call.url.includes('build.json')).map(call => new URL(call.url).search);
  assert.equal(new Set(queries).size, 3, 'Stale public responses receive a fresh cache key on each attempt');
});

test('an existing matching built or queued commit avoids a duplicate request', async () => {
  for (const status of ['built', 'queued', 'building']) {
    const h = harness([
      event('/pages', config), event('/pages/builds/latest', build(commit, status)),
      ...(status === 'built' ? [] : [event('/pages/builds/latest', build(commit, 'built'))]),
      ...publicSuccess()
    ]);
    await publishPages(h.options);
    assert.equal(h.remaining.length, 0);
    assert(!h.calls.some(call => call.options.method === 'POST'));
  }
});

test('configured workflow or a different branch/path is never taken over', async () => {
  for (const other of [
    { build_type: 'workflow', source: config.source },
    { ...config, source: { branch: 'main', path: '/' } },
    { ...config, source: { branch: 'gh-pages', path: '/docs' } }
  ]) {
    const h = harness([event('/pages', other)]);
    await assert.rejects(publishPages(h.options), /will not change its source|was not changed/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.method, 'GET');
  }
});

test('an expected build error fails without exposing API error contents', async () => {
  const h = harness([
    event('/pages', config), event('/pages/builds/latest', build(oldCommit, 'built')),
    event('/pages/builds', { status: 'queued' }, 201, 'POST'),
    event('/pages/builds/latest', { ...build(commit, 'errored', 2), error: { message: token } })
  ]);
  await assert.rejects(publishPages(h.options), error => /errored build/.test(error.message) && !error.message.includes(token));
  assert(!h.calls.some(call => call.url.startsWith(publicRoot)));
});

test('a rerun ignores the previous failure while its replacement build queues', async () => {
  const previous = build(commit, 'errored', 1);
  const h = harness([
    event('/pages', config), event('/pages/builds/latest', previous),
    event('/pages/builds', { status: 'queued' }, 201, 'POST'),
    event('/pages/builds/latest', previous),
    event('/pages/builds/latest', build(commit, 'building', 2)),
    event('/pages/builds/latest', build(commit, 'built', 2)), ...publicSuccess()
  ]);
  await publishPages(h.options);
  assert.equal(h.pauses.length, 2);
  assert.equal(h.remaining.length, 0);
});

test('stale commit responses and stale public bytes each have a bounded wait', async () => {
  const stale = harness([
    event('/pages', config), event('/pages/builds/latest', build(oldCommit, 'built')),
    event('/pages/builds', { status: 'queued' }, 201, 'POST'),
    ...Array.from({ length: 3 }, () => event('/pages/builds/latest', build(oldCommit, 'built')))
  ], { timeoutMs: 25 });
  await assert.rejects(publishPages(stale.options), /timed out.*expected commit/);
  assert.equal(stale.elapsed(), 25);
  const publicStale = harness([
    event('/pages', config), event('/pages/builds/latest', build(commit, 'built')),
    ...Array.from({ length: 3 }, () => event('build.json', { ...manifest, sha256: '0'.repeat(64) }))
  ], { timeoutMs: 25 });
  await assert.rejects(publishPages(publicStale.options), /timed out.*public build manifest/);
  assert.equal(publicStale.elapsed(), 25);
});

test('transient polling and invalid public responses retry without leaking fetch errors', async () => {
  const h = harness([
    event('/pages', config), event('/pages/builds/latest', build(commit, 'queued')),
    { ...event('/pages/builds/latest', null), error: new Error(token) },
    event('/pages/builds/latest', null, 503),
    event('/pages/builds/latest', build(commit, 'built')),
    { ...event('build.json', null), invalidJSON: true }, ...publicSuccess()
  ]);
  await publishPages(h.options);
  assert(h.messages.every(message => !message.includes(token)));
  assert.equal(h.remaining.length, 0);
});

test('configuration/request permissions fail before polling or public verification', async () => {
  for (const status of [403, 404]) {
    const h = harness([event('/pages', null, status)]);
    await assert.rejects(publishPages(h.options), /Cannot confirm/);
    assert.equal(h.calls.length, 1);
  }
  const rejected = harness([
    event('/pages', config), event('/pages/builds/latest', build(oldCommit, 'built')),
    event('/pages/builds', null, 403, 'POST')
  ]);
  await assert.rejects(publishPages(rejected.options), /build request failed \(HTTP 403\)/);
  assert.equal(rejected.calls.length, 3);
});

test('each request is abortable and transport errors do not expose credentials', async () => {
  const keepAlive = setTimeout(() => {}, 250);
  try {
    await assert.rejects(getPagesConfiguration({ repository, token, timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error(token)), { once: true });
    }) }), error => /timed out/.test(error.message) && !error.message.includes(token));
  } finally { clearTimeout(keepAlive); }
});

test('untrusted repository paths and malformed release identity never issue requests', async () => {
  for (const overrides of [
    { repository: 'owner/repo/../../anything' }, { repository: 'owner@evil.invalid/repo' },
    { expectedCommit: 'short' }, { manifest: { ...manifest, sha256: 'wrong' } }
  ]) {
    const h = harness([], overrides);
    await assert.rejects(publishPages(h.options));
    assert.equal(h.calls.length, 0);
  }
});

test('status distinguishes branch publishing, Actions, and unreadable configuration', () => {
  const branch = describePages({ status: 200, config });
  assert.equal(branch.enabled, false);
  assert.equal(branch.branchEnabled, true);
  assert.match(branch.message, /configured for the gh-pages branch/);
  assert.doesNotMatch(branch.message, /needs.*setup|must be configured/);
  assert.equal(describePages({ status: 200, config: { build_type: 'workflow' } }).enabled, true);
  assert.match(describePages({ status: 403, config: null }).message, /hosting status is unknown/);
  assert.match(describePages({ status: 404, config: null }).message, /No accessible Pages configuration/);
});
