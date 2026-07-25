'use strict';

// Commit search. The contributions GraphQL API refuses to itemize private-repo
// activity (it only reports a restrictedContributionsCount), but the commit
// search API returns those repos by name for your own token - so this is the
// only way to label a private week.
//
// The search API caps at 30 requests/min and 1000 results per query, and its
// *secondary* limit punishes bursts. We space requests ~3s apart, back off 60s
// on a 403, and recursively split any date range over 1000 results so every
// commit is captured regardless of activity level.

const { execFileSync } = require('child_process');

const SEARCH_GAP = 3000;
const MAX_ATTEMPTS = 8;

let lastSearch = 0;

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.ceil(ms));
}

function ymd(d) { return d.toISOString().slice(0, 10); }

function midDate(from, to) {
  const a = new Date(from + 'T00:00:00Z').getTime();
  const b = new Date(to + 'T00:00:00Z').getTime();
  return ymd(new Date(a + Math.floor((b - a) / 2)));
}

// 'all' searches everything the token can see; 'public' and 'private' narrow it
// server-side, which is what lets --exclude-private skip pages it would discard.
function visibilityQualifier(visibility) {
  if (visibility === 'public') return ' is:public';
  if (visibility === 'private') return ' is:private';
  return '';
}

// A 60s pause with no output reads as a hang, and report() is a no-op when stdout
// isn't a TTY - so the backoff gets its own permanent line either way. On a TTY the
// in-place progress line is cleared first so the notice doesn't land on top of it.
function noticeBackoff(attempt) {
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  console.log(`  Rate limited by GitHub - waiting 60s before retry ${attempt + 1}/${MAX_ATTEMPTS}…`);
}

function searchPage(login, from, to, page, visibility, report) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const wait = lastSearch + SEARCH_GAP - Date.now();
    if (wait > 0) sleepSync(wait);
    lastSearch = Date.now();
    try {
      // stdio pipes stderr rather than letting execFileSync forward it to ours,
      // so gh's raw "HTTP 403" dump doesn't print mid-retry and make a working
      // backoff look like a crash.
      const raw = execFileSync('gh', [
        'api', '-X', 'GET', 'search/commits',
        '-f', `q=author:${login} author-date:${from}..${to}${visibilityQualifier(visibility)}`,
        '-f', 'per_page=100', '-f', `page=${page}`,
        '-f', 'sort=author-date', '-f', 'order=desc',
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const json = JSON.parse(raw);
      if (json.message && json.total_count === undefined) {
        if (/rate limit/i.test(json.message)) { noticeBackoff(attempt); sleepSync(60000); continue; }
        throw new Error(`Search API error: ${json.message}`);
      }
      return json;
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('GitHub CLI (gh) not found. Install from https://cli.github.com/ and run `gh auth login`.');
      const msg = ((e.stderr || '').toString() + (e.stdout || '').toString()) || e.message || '';
      if (/rate limit|secondary rate|abuse detection/i.test(msg) || /HTTP 403/.test(msg)) { noticeBackoff(attempt); sleepSync(60000); continue; }
      throw new Error(`gh command failed: ${msg}`);
    }
  }
  throw new Error('Repeatedly rate-limited by the search API. Try again in a few minutes.');
}

// Returns [{ repo, date, owner, fork, priv }], SHA-deduped. Nothing else is
// filtered, so a caller can re-aggregate under different flags without refetching.
function fetchCommits(login, from, to, options) {
  const opts = options || {};
  const visibility = opts.visibility || 'all';
  const report = opts.onProgress || (() => {});
  const raw = [];

  function collect(items) {
    for (const it of items) {
      raw.push({
        sha: it.sha,
        repo: it.repository.full_name,
        date: it.commit.author.date.slice(0, 10),
        fork: !!it.repository.fork,
        owner: (it.repository.owner && it.repository.owner.login) || '',
        priv: !!it.repository.private,
      });
    }
  }

  function range(f, t) {
    const first = searchPage(login, f, t, 1, visibility, report);
    const count = first.total_count || 0;
    if (count === 0) return;
    if (count > 1000) {
      const mid = midDate(f, t);
      if (mid <= f || mid >= t) { collect(first.items); return; } // single day > 1000: accept the cap
      range(f, mid);
      range(ymd(new Date(new Date(mid + 'T00:00:00Z').getTime() + 86400000)), t);
      return;
    }
    collect(first.items);
    report(`${raw.length} commits`);
    const pages = Math.ceil(count / 100);
    for (let p = 2; p <= pages; p++) {
      collect(searchPage(login, f, t, p, visibility, report).items);
      report(`${raw.length} commits`);
    }
  }

  range(from, to);
  return dedupe(raw, login);
}

// The same commit exists in every fork (same SHA). Keep one canonical copy -
// prefer a repo the user owns, then a non-fork - so a week's top repos aren't
// just the same work counted once per fork.
function dedupe(items, login) {
  const score = (it) => (it.owner === login ? 2 : 0) + (it.fork ? 0 : 1);
  const bySha = new Map();
  for (const it of items) {
    const cur = bySha.get(it.sha);
    if (!cur || score(it) > score(cur)) bySha.set(it.sha, it);
  }
  // A short sha is kept so a cached public-only window can be topped up with a
  // private fetch later and re-deduped as one set (10 chars is unique enough
  // within one author's commits, and keeps the cache small).
  return [...bySha.values()].map((it) => ({ sha: String(it.sha).slice(0, 10), repo: it.repo, date: it.date, owner: it.owner, fork: it.fork, priv: it.priv }));
}

module.exports = { fetchCommits, dedupe };
