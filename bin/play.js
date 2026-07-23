'use strict';

// gh-commit-history play - catch your contribution squares as they fall, week by week.
// Data comes from GitHub's official contribution calendar (GraphQL), fetched year by
// year via the gh CLI. Rendering is three.js from CDN inside a generated HTML file.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.gh-commit-history');

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (e.code === 'ENOENT') {
      fail('GitHub CLI (gh) not found. Install it from https://cli.github.com/ and run `gh auth login`.');
    }
    const stderr = (e.stderr || '').toString().trim();
    fail(`gh command failed: ${stderr || e.message}`);
  }
}

function resolveUsername(given) {
  if (given) return given;
  const out = gh(['api', 'user', '--jq', '.login']).trim();
  if (!out) fail('Could not determine your username. Pass one explicitly or run `gh auth login`.');
  return out;
}

function openInBrowser(file) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { execFileSync(cmd, [file], { stdio: 'ignore' }); } catch { /* ignore */ }
}

const HELP = `
gh-commit-history play - catch your contribution squares as they fall

Usage:
  npx gh-commit-history play [username] [options]

  Defaults to your authenticated GitHub user. Uses GitHub's official
  contribution calendar (the profile green squares), fetched via gh.

Options:
  --years <n>          Limit to the past n years (default: all history)
  -o, --output <path>  Output HTML path (default: ~/.gh-commit-history/<user>-play.html)
  --no-open            Don't auto-open the browser
  --no-cache           Skip cache, fetch everything fresh
  -h, --help           Show this help

Controls:
  A/D or arrow keys    Step between the 7 weekday lanes
  P                    Pause
  R                    Replay

Red penalty boxes drop on empty days (up to two a week) - catching one costs
a point.
`;

function parseArgs(argv) {
  const opts = { username: null, years: null, output: null, open: true, cache: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--years') opts.years = parseInt(argv[++i], 10);
    else if (a === '--output' || a === '-o') opts.output = argv[++i];
    else if (a === '--no-open') opts.open = false;
    else if (a === '--no-cache') opts.cache = false;
    else if (a.startsWith('-')) fail(`Unknown option: ${a}`);
    else opts.username = a.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Contribution calendar fetch (official green squares), one GraphQL call per year
// ---------------------------------------------------------------------------
const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

const CAL_QUERY = `query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){
    contributionsCollection(from:$from,to:$to){
      contributionCalendar{
        weeks{ contributionDays{ date contributionCount contributionLevel } }
      }
    }
  }
}`;

function fetchYear(login, year, toDate) {
  const from = `${year}-01-01T00:00:00Z`;
  const to = toDate || `${year}-12-31T23:59:59Z`;
  const raw = gh(['api', 'graphql', '-f', `query=${CAL_QUERY}`, '-f', `login=${login}`, '-f', `from=${from}`, '-f', `to=${to}`]);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail(`Unexpected GraphQL response for ${year}.`); }
  const cal = parsed?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) fail(`No contribution data for ${login} (${year}). Does the user exist?`);
  const days = [];
  for (const w of cal.weeks) {
    for (const d of w.contributionDays) {
      days.push([d.date, d.contributionCount, LEVELS[d.contributionLevel] || 0]);
    }
  }
  return days;
}

const REPO_QUERY = `query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){
    contributionsCollection(from:$from,to:$to){
      commitContributionsByRepository(maxRepositories:100){
        repository{ nameWithOwner }
        contributions(first:100){ nodes{ occurredAt commitCount } }
      }
      issueContributionsByRepository(maxRepositories:100){
        repository{ nameWithOwner }
        contributions(first:100){ nodes{ occurredAt } }
      }
      pullRequestContributionsByRepository(maxRepositories:100){
        repository{ nameWithOwner }
        contributions(first:100){ nodes{ occurredAt } }
      }
      pullRequestReviewContributionsByRepository(maxRepositories:100){
        repository{ nameWithOwner }
        contributions(first:100){ nodes{ occurredAt } }
      }
    }
  }
}`;

function quarterOf(dateStr) { const m = +dateStr.slice(5, 7); return dateStr.slice(0, 4) + '-Q' + (Math.floor((m - 1) / 3) + 1); }

function quarterRange(q) {
  const y = +q.slice(0, 4), sm = (+q.slice(6) - 1) * 3 + 1, em = sm + 2;
  const lastDay = new Date(Date.UTC(y, em, 0)).getUTCDate();
  return [
    `${y}-${String(sm).padStart(2, '0')}-01T00:00:00Z`,
    `${y}-${String(em).padStart(2, '0')}-${lastDay}T23:59:59Z`,
  ];
}

// Per-week top repos, quarter by quarter, across commits + issues + PRs + reviews
// (the same types the contribution calendar counts, minus restricted/private-org
// activity the API won't itemize). Commit nodes are per-day so a <=92-day window
// never paginates; issue/PR/review nodes are per-item, capped at 100 per repo per
// quarter, which at worst slightly undercounts a monster repo's tail.
function fetchQuarter(login, q) {
  const [from, to] = quarterRange(q);
  const raw = gh(['api', 'graphql', '-f', `query=${REPO_QUERY}`, '-f', `login=${login}`, '-f', `from=${from}`, '-f', `to=${to}`]);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail(`Unexpected GraphQL response for ${q}.`); }
  const col = parsed?.data?.user?.contributionsCollection || {};
  const entries = []; // [date, repo, contributions]
  for (const key of ['commitContributionsByRepository', 'issueContributionsByRepository',
    'pullRequestContributionsByRepository', 'pullRequestReviewContributionsByRepository']) {
    for (const r of col[key] || []) {
      const name = r.repository.nameWithOwner;
      for (const n of r.contributions.nodes) entries.push([n.occurredAt.slice(0, 10), name, n.commitCount || 1]);
    }
  }
  return entries;
}

function cachePath(login) { return path.join(CACHE_DIR, `${login}-play.json`); }

function fetchCalendar(login, opts) {
  const now = new Date();
  const createdRaw = gh(['api', `users/${login}`, '--jq', '.created_at']).trim();
  const created = createdRaw ? new Date(createdRaw) : null;
  if (!created) fail(`Could not look up account creation for ${login}.`);

  let startYear = created.getUTCFullYear();
  const nowYear = now.getUTCFullYear();
  let cutoff = null; // --years is a rolling window, not calendar years
  if (opts.years) {
    const c = new Date(now);
    c.setUTCFullYear(c.getUTCFullYear() - opts.years);
    cutoff = c.toISOString().slice(0, 10);
    startYear = Math.max(startYear, c.getUTCFullYear());
  }

  let cache = { years: {} };
  if (opts.cache) {
    try { cache = JSON.parse(fs.readFileSync(cachePath(login), 'utf8')); } catch { /* fresh */ }
    if (!cache.years) cache = { years: {} };
  }

  const dayMap = new Map(); // date -> [count, level]
  for (let y = startYear; y <= nowYear; y++) {
    // Past years never change; the current year is always refetched so it's up to date.
    let days = y < nowYear && opts.cache ? cache.years[y] : null;
    if (!days) {
      days = fetchYear(login, y, y === nowYear ? now.toISOString() : null);
      cache.years[y] = days;
      if (opts.cache) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cachePath(login), JSON.stringify(cache));
      }
      const total = days.reduce((a, d) => a + d[1], 0);
      console.log(`  ${y}: ${total.toLocaleString()} contributions`);
    } else {
      const total = days.reduce((a, d) => a + d[1], 0);
      console.log(`  ${y}: ${total.toLocaleString()} contributions (cached)`);
    }
    for (const [date, count, level] of days) {
      if (cutoff && date < cutoff) continue;
      dayMap.set(date, [count, level]);
    }
  }

  // Per-week top repos: commit contributions for every quarter with activity.
  const qSet = new Set();
  for (const [date, [count]] of dayMap) if (count > 0) qSet.add(quarterOf(date));
  const quarters = [...qSet].sort();
  const nowQ = quarterOf(now.toISOString().slice(0, 10));
  // repoQuarters2: v2 includes issues/PRs/reviews, not just commits
  cache.repoQuarters2 = cache.repoQuarters2 || {};
  const repoDay = []; // [date, repo, contributions]
  let fetched = 0;
  for (const q of quarters) {
    let entries = q !== nowQ && opts.cache ? cache.repoQuarters2[q] : null;
    if (!entries) {
      if (!fetched) process.stdout.write('  top repos: ');
      entries = fetchQuarter(login, q);
      cache.repoQuarters2[q] = entries;
      fetched++;
      process.stdout.write('.');
      if (opts.cache) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cachePath(login), JSON.stringify(cache));
      }
    }
    repoDay.push(...entries);
  }
  if (fetched) console.log(` ${fetched} quarter(s) fetched`);
  return { dayMap, repoDay };
}

// ---------------------------------------------------------------------------
// Build Sunday-aligned weeks trimmed to the first..last active day
// ---------------------------------------------------------------------------
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekStart(s) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.toISOString().slice(0, 10); }

function buildWeeks(dayMap) {
  const active = [...dayMap.entries()].filter(([, v]) => v[0] > 0).map(([k]) => k).sort();
  if (!active.length) return null;
  const first = weekStart(active[0]);
  const last = active[active.length - 1];
  const weeks = [];
  // Keyed by week-start year (a week belongs to the year its Sunday falls in), so the
  // narration cards, end-screen rows, and in-game collection all agree at year boundaries.
  const yearStats = {}; // year -> { active, total }
  for (let s = first; s <= last; s = addDays(s, 7)) {
    const days = [];
    let weekTotal = 0;
    for (let i = 0; i < 7; i++) {
      const date = addDays(s, i);
      const [count, level] = dayMap.get(date) || [0, 0];
      days.push([count, level]);
      weekTotal += count;
    }
    const y = s.slice(0, 4);
    yearStats[y] = yearStats[y] || { active: 0, total: 0 };
    yearStats[y].total += weekTotal;
    if (weekTotal > 0) yearStats[y].active++;
    weeks.push({ s, d: days });
  }
  for (const y of Object.keys(yearStats)) if (yearStats[y].total === 0) delete yearStats[y];
  return { weeks, yearStats };
}

// ---------------------------------------------------------------------------
// Game HTML
// ---------------------------------------------------------------------------
function renderHTML(payload) {
  const title = `${payload.login} · contribution catch`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="icon" href="data:,">
<style>
  :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --text:#e6edf3; --dim:#8b949e; --green:#3fb950; --accent:#58a6ff; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { height:100%; overflow:hidden; background:var(--bg); color:var(--text); touch-action:none;
    -webkit-user-select:none; user-select:none;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  #scene { position:fixed; inset:0; }
  .hud { position:fixed; z-index:10; user-select:none; }
  #score { top:18px; left:20px; background:rgba(22,27,34,.85); border:1px solid var(--border);
    border-radius:10px; padding:10px 16px; }
  #score .n { font-size:30px; font-weight:700; color:var(--green); transition:transform .1s; display:inline-block;
    font-variant-numeric:tabular-nums; }
  #score .sub { font-size:12px; color:var(--dim); margin-top:2px; }
  #weeklabel { top:18px; left:50%; transform:translateX(-50%); font-size:14px; color:var(--dim);
    background:rgba(22,27,34,.85); border:1px solid var(--border); border-radius:10px; padding:8px 14px;
    text-align:center; }
  #weeklabel small { display:block; font-size:11px; color:var(--green); margin-top:2px; max-width:70vw;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #weeklabel small .pfx, #weeklabel small.priv { color:var(--dim); }
  #weeklabel:empty { display:none; }
  #keys { top:18px; right:20px; font-size:12px; color:var(--dim); text-align:right; line-height:1.7;
    background:rgba(22,27,34,.85); border:1px solid var(--border); border-radius:10px; padding:8px 14px; }
  kbd { background:var(--panel); border:1px solid var(--border); border-bottom-width:2px; border-radius:4px;
    padding:0 5px; font-size:11px; color:var(--text); }
  #card { top:34%; left:50%; transform:translate(-50%,-50%) scale(.95); text-align:center; opacity:0;
    transition:opacity .3s, transform .3s; pointer-events:none; }
  #card.show { opacity:1; transform:translate(-50%,-50%) scale(1); }
  #card .big { font-size:64px; font-weight:800; letter-spacing:-1px; }
  #card .sub { font-size:16px; color:var(--dim); margin-top:6px; }
  #timeline { position:fixed; left:0; right:0; bottom:0; z-index:9; display:block; }
  #end { position:fixed; inset:0; z-index:20; display:none; align-items:center; justify-content:center;
    background:rgba(13,17,23,.88); }
  #end .panel { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:32px 40px;
    max-width:520px; width:92%; max-height:80vh; overflow-y:auto; }
  #end h1 { font-size:22px; margin-bottom:4px; }
  #end .pct { font-size:44px; font-weight:800; color:var(--green); margin:10px 0 2px; }
  #end .sub { color:var(--dim); font-size:14px; margin-bottom:18px; }
  .yrow { display:flex; align-items:center; gap:10px; font-size:13px; margin:6px 0; }
  .yrow .y { width:42px; color:var(--dim); }
  .yrow .bar { flex:1; height:8px; background:#21262d; border-radius:4px; overflow:hidden; }
  .yrow .bar i { display:block; height:100%; background:var(--green); border-radius:4px; }
  .yrow .v { width:120px; text-align:right; color:var(--dim); font-variant-numeric:tabular-nums; }
  #end .replay { margin-top:20px; text-align:center; color:var(--dim); font-size:13px; }
  .pop { position:fixed; z-index:15; font-weight:700; color:var(--green); font-size:18px; pointer-events:none;
    text-shadow:0 1px 6px rgba(0,0,0,.6); animation:rise .8s ease-out forwards; }
  .pop.bad { color:#f85149; }
  @keyframes rise { from { opacity:1; transform:translateY(0); } to { opacity:0; transform:translateY(-46px); } }
  #boot { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; color:var(--dim);
    font-size:14px; z-index:5; }
  #end .replay { cursor:pointer; }
  @media (max-width:600px) {
    #score { top:10px; left:10px; padding:7px 12px; }
    #score .n { font-size:22px; }
    #score .sub { font-size:10px; }
    #weeklabel { top:auto; bottom:92px; font-size:12px; padding:6px 10px; white-space:nowrap; }
    #keys { top:10px; right:10px; font-size:10px; padding:6px 10px; }
    #card .big { font-size:42px; }
    #card .sub { font-size:13px; }
    #end .panel { padding:22px 20px; }
    .yrow .v { width:96px; font-size:11px; }
  }
</style>
</head><body>
<div id="boot">loading three.js…</div>
<canvas id="scene"></canvas>
<div class="hud" id="score"><span class="n" id="scoreN">0</span><div class="sub" id="scoreSub"></div></div>
<div class="hud" id="weeklabel"></div>
<div class="hud" id="keys"><kbd>A</kbd> <kbd>D</kbd> move · <kbd>P</kbd> pause · <kbd>R</kbd> replay</div>
<div class="hud" id="card"><div class="big"></div><div class="sub"></div></div>
<canvas id="timeline"></canvas>
<div id="end"><div class="panel">
  <h1 id="endTitle"></h1><div class="pct" id="endPct"></div><div class="sub" id="endSub"></div>
  <div id="endYears"></div><div class="replay" id="replay">press <kbd>R</kbd> to replay</div>
</div></div>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
} }
</script>
<script>
  setTimeout(function () {
    if (!window.__booted) document.getElementById('boot').textContent =
      'Could not load three.js from CDN - this game needs an internet connection.';
  }, 6000);
</script>
<script type="module">
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const D = ${JSON.stringify(payload)};
window.__booted = true;
document.getElementById('boot').style.display = 'none';

// GitHub dark-theme contribution greens by level (1-4)
const GREENS = [null, '#0e4429', '#006d32', '#26a641', '#39d353'];
const FOOT = [0, 0.62, 0.74, 0.86, 0.98];   // cube footprint by level
const TALL = [0, 0.50, 0.80, 1.15, 1.55];   // cube height by level - more contributions, taller cube

const params = new URLSearchParams(location.search);
const URL_SPEED = Math.max(0.25, Math.min(20, parseFloat(params.get('speed')) || 1));
const AUTOPILOT = params.get('autopilot') === '1';

const LANES = 7, LANE_W = 1.18;
const laneX = i => (i - 3) * LANE_W;
const SPAWN_Y = 9.2, FALL_SPEED = 2.85, PADDLE_TOP = 0.58;
const PENALTY = '#a40e26'; // deep crimson penalty cubes - dark but unmissable
const SPAWN_BASE = 0.3, SPAWN_PER_LANE = 0.1; // gap before each cube grows with lane distance
const GAP_MIN = 4; // runs of >= this many empty weeks get a narration card
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ---- timeline events: year cards, gap cards, playable weeks -------------
const weeks = D.weeks;
const weekTotal = w => w.d.reduce((a, x) => a + x[0], 0);
const events = [];
{
  let curYear = null, gap = 0, gapFrom = 0;
  const flushGap = end => {
    if (gap >= GAP_MIN) events.push({ type: 'gap', n: gap, from: gapFrom, to: end });
    gap = 0;
  };
  weeks.forEach((w, i) => {
    const y = w.s.slice(0, 4);
    if (y !== curYear) {
      flushGap(i);
      if (D.years[y]) events.push({ type: 'year', year: y, stats: D.years[y], week: i });
      curYear = y;
    }
    if (weekTotal(w) === 0) { if (gap === 0) gapFrom = i; gap++; return; }
    flushGap(i);
    events.push({ type: 'week', week: i });
  });
}
const grandTotal = weeks.reduce((a, w) => a + weekTotal(w), 0);

// ---- three.js scene ------------------------------------------------------
const canvas = document.getElementById('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (e) {
  document.getElementById('boot').style.display = 'flex';
  document.getElementById('boot').textContent = 'WebGL is not available in this browser.';
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0d1117');
scene.fog = new THREE.Fog('#0d1117', 12, 24);
// Nearly head-on framing: the game happens on one line of lanes, so the camera
// looks at that plane with just enough tilt to show cube tops - no deep corridor.
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 60);
camera.position.set(0, 4.2, 11.2);
camera.lookAt(0, 3.6, 0);

scene.add(new THREE.AmbientLight('#b8c4d0', 0.75));
const key = new THREE.DirectionalLight('#ffffff', 1.9);
key.position.set(4, 9, 6);
scene.add(key);
const rim = new THREE.DirectionalLight('#58a6ff', 0.5);
rim.position.set(-6, 4, -4);
scene.add(rim);

// a slim platform hugging the play line, with a little room for the day markings
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 3.0),
  new THREE.MeshStandardMaterial({ color: '#10151c', roughness: 0.95 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.z = -0.3;
scene.add(floor);
const laneMats = [];
for (let i = 0; i < LANES; i++) {
  const m = new THREE.MeshBasicMaterial({ color: '#161b22', transparent: true, opacity: 0.6 });
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W - 0.14, 2.4), m);
  strip.rotation.x = -Math.PI / 2;
  strip.position.set(laneX(i), 0.01, -0.5);
  scene.add(strip);
  laneMats.push(m);
}

// weekday markers painted flat on the ground in front of the paddle, stretched
// deep like road markings so the grazing camera angle reads them as letters;
// the active lane's letter brightens
const dayLabelMats = [];
for (let i = 0; i < LANES; i++) {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const cx = cv.getContext('2d');
  cx.font = '700 96px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillStyle = '#ffffff';
  cx.fillText(DAY_NAMES[i][0], 64, 70);
  const m = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, opacity: 0.35, color: '#8b949e' });
  const tile = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 1.05), m);
  tile.position.set(laneX(i), 0.02, 0.7);
  tile.rotation.x = -Math.PI / 2;
  scene.add(tile);
  dayLabelMats.push(m);
}

// paddle (the collector tray)
const paddleMat = new THREE.MeshPhysicalMaterial({ color: '#58a6ff', roughness: 0.3, clearcoat: 1, emissive: '#1f6feb', emissiveIntensity: 0.35 });
const paddle = new THREE.Mesh(new RoundedBoxGeometry(1.04, 0.22, 1.04, 3, 0.09), paddleMat);
paddle.position.set(0, PADDLE_TOP - 0.13, 0);
scene.add(paddle);
const paddleSpring = { x: 0, v: 0 }; // horizontal glide
const paddleSquash = { x: 1, v: 0 };

// shared rounded-cube geometry; jelly comes from scale springs + a vertex wobble
const cubeGeo = new RoundedBoxGeometry(1, 1, 1, 4, 0.14);
function jellyMaterial(hex) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: hex, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.4,
    transparent: true, opacity: 0.94,
    emissive: hex, emissiveIntensity: 0.22,
  });
  mat.userData.uT = { value: 99 };
  mat.userData.uAmp = { value: 0 };
  mat.onBeforeCompile = shader => {
    shader.uniforms.uT = mat.userData.uT;
    shader.uniforms.uAmp = mat.userData.uAmp;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\\nuniform float uT; uniform float uAmp;')
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'float _w = sin(position.y * 9.0 + position.x * 4.0 - uT * 24.0) * exp(-4.5 * uT);',
        'transformed += normal * (uAmp * _w);',
      ].join('\\n'));
  };
  return mat;
}

function spring(s, dt, k, c) { s.v += (-k * (s.x - 1) - c * s.v) * dt; s.x += s.v * dt; }

// ---- game state ----------------------------------------------------------
const G = {
  ei: 0,               // index into events
  state: 'card',       // card | week | end
  cardT: 0, cardDur: 0,
  spawnQ: [],          // pending cubes for current week: {t, lane, count, level}
  weekT: 0,
  cubes: [],
  lane: 3,
  score: 0, caught: 0, missed: 0, reds: 0,
  perYear: {},         // year -> collected
  perWeekCollected: new Array(weeks.length).fill(0),
  playhead: 0,         // week index (fractional) for the timeline strip
  playheadTarget: 0,
  curWeek: -1,
  paused: false,
  displayScore: 0,
  done: false,
};

const scoreN = document.getElementById('scoreN');
const scoreSub = document.getElementById('scoreSub');
scoreSub.textContent = 'of ' + grandTotal.toLocaleString() + ' contributions · ' + D.login;
const weekLabel = document.getElementById('weeklabel');
const card = document.getElementById('card');

function showCard(big, sub, dur) {
  card.querySelector('.big').textContent = big;
  card.querySelector('.sub').textContent = sub;
  card.classList.add('show');
  G.cardT = 0; G.cardDur = dur;
}

function fmtWeek(s) {
  const d = new Date(s + 'T00:00:00Z');
  return 'Week of ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
}

function startEvent() {
  if (G.ei >= events.length) { endGame(); return; }
  const ev = events[G.ei];
  if (ev.type === 'year') {
    G.state = 'card';
    G.playheadTarget = ev.week;
    showCard(ev.year, 'active ' + ev.stats.active + ' week' + (ev.stats.active === 1 ? '' : 's') +
      ' · ' + ev.stats.total.toLocaleString() + ' contributions', 2.3);
  } else if (ev.type === 'gap') {
    G.state = 'card';
    G.playheadTarget = ev.to;
    showCard('· · ·', ev.n + ' quiet weeks', 1.4);
  } else {
    G.state = 'week';
    G.curWeek = ev.week;
    G.playheadTarget = ev.week;
    G.weekT = 0;
    G.spawnQ = [];
    const w = weeks[ev.week];
    // Each week drops its smallest days first, building to the biggest; spacing
    // scales with the lane distance from the previous cube so jumps stay catchable.
    const active = [];
    w.d.forEach(([count, level], day) => {
      if (count > 0) active.push({ t: 0, lane: day, count, level, day });
    });
    weekLabel.innerHTML = fmtWeek(w.s) +
      (w.r && w.r.length
        ? '<small><span class="pfx">top: </span>' + w.r.join(' · ') + '</small>'
        : '<small class="priv">private repos</small>');
    active.sort((a, b) => a.count - b.count || a.day - b.day);
    // Penalty cubes: up to two random empty days drop red boxes, mixed into the
    // order at random. Catching one costs a point.
    const empty = [];
    w.d.forEach(([count], day) => { if (count === 0) empty.push(day); });
    for (let i = empty.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [empty[i], empty[j]] = [empty[j], empty[i]];
    }
    for (const day of empty.slice(0, 2)) {
      const pos = Math.floor(Math.random() * (active.length + 1));
      active.splice(pos, 0, { t: 0, lane: day, count: 0, level: 0, day, red: true });
    }
    let t = 0, prev = null;
    for (const q of active) {
      if (prev !== null) t += SPAWN_BASE + SPAWN_PER_LANE * Math.abs(q.lane - prev);
      q.t = t; prev = q.lane;
      G.spawnQ.push(q);
    }
  }
}

function spawnCube(q) {
  const mat = jellyMaterial(q.red ? PENALTY : GREENS[q.level]);
  const mesh = new THREE.Mesh(cubeGeo, mat);
  const f = q.red ? 0.6 : FOOT[q.level], h = q.red ? 0.6 : TALL[q.level];
  mesh.position.set(laneX(q.lane), SPAWN_Y, 0);
  scene.add(mesh);
  const c = {
    mesh, mat, lane: q.lane, count: q.count, level: q.level, red: !!q.red, f, h,
    y: SPAWN_Y, state: 'fall', fade: 1, t: 0,
    sx: { x: 1, v: -2.5 }, sy: { x: 1, v: 6 }, sz: { x: 1, v: -2.5 },
  };
  wobble(c, 0.05);
  G.cubes.push(c);
}

function wobble(c, amp) { c.mat.userData.uT.value = 0; c.mat.userData.uAmp.value = amp; }

function popText(worldPos, text, bad) {
  const v = worldPos.clone().project(camera);
  const el = document.createElement('div');
  el.className = bad ? 'pop bad' : 'pop';
  el.textContent = text;
  el.style.left = ((v.x * 0.5 + 0.5) * innerWidth - 14) + 'px';
  el.style.top = ((-v.y * 0.5 + 0.5) * innerHeight - 30) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 850);
}

function catchCube(c) {
  c.state = 'caught'; c.t = 0;
  c.sy.v = -14; c.sx.v = 8; c.sz.v = 8;
  wobble(c, 0.12);
  paddleSquash.v = -6;
  const y = weeks[G.curWeek].s.slice(0, 4);
  if (c.red) {
    G.score -= 1; G.reds++;
    G.perYear[y] = (G.perYear[y] || 0) - 1;
    popText(c.mesh.position, '-1', true);
    return;
  }
  G.score += c.count; G.caught++;
  G.perYear[y] = (G.perYear[y] || 0) + c.count;
  G.perWeekCollected[G.curWeek] += c.count;
  popText(c.mesh.position, '+' + c.count);
}

function missCube(c) {
  c.state = 'missed'; c.t = 0;
  c.sy.v = -10; c.sx.v = 5; c.sz.v = 5;
  wobble(c, 0.09);
  if (!c.red) G.missed++; // letting a red one splat is the point
  c.mat.color.set('#484f58');
  c.mat.emissiveIntensity = 0;
}

function endGame() {
  if (G.done) return;
  G.done = true;
  G.state = 'end';
  const pct = grandTotal ? Math.round((G.score / grandTotal) * 1000) / 10 : 0;
  document.getElementById('endTitle').textContent = D.login + "'s contribution catch";
  document.getElementById('endPct').textContent = pct + '%';
  document.getElementById('endSub').textContent =
    G.score.toLocaleString() + ' of ' + grandTotal.toLocaleString() + ' contributions collected' +
    (G.reds ? ' · -' + G.reds + ' from red boxes' : '');
  const rows = Object.keys(D.years).sort().map(y => {
    const got = G.perYear[y] || 0, tot = D.years[y].total;
    const w = tot ? Math.round((got / tot) * 100) : 0;
    return '<div class="yrow"><span class="y">' + y + '</span><span class="bar"><i style="width:' + w +
      '%"></i></span><span class="v">' + got.toLocaleString() + ' / ' + tot.toLocaleString() + '</span></div>';
  }).join('');
  document.getElementById('endYears').innerHTML = rows;
  document.getElementById('end').style.display = 'flex';
}

// ---- input ---------------------------------------------------------------
addEventListener('keydown', e => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'arrowleft') G.lane = Math.max(0, G.lane - 1);
  else if (k === 'd' || k === 'arrowright') G.lane = Math.min(LANES - 1, G.lane + 1);
  else if (k === 'p') G.paused = !G.paused;
  else if (k === 'r') location.reload();
});

// touch / click: tap the left or right half to step, or drag to steer directly
const TOUCH = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
if (TOUCH) document.getElementById('keys').innerHTML = 'tap sides or drag<br>to move';
const raycaster = new THREE.Raycaster();
const playPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
function laneFromClientX(cx, cy) {
  raycaster.setFromCamera(new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1), camera);
  const pt = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(playPlane, pt)) return G.lane;
  return Math.max(0, Math.min(LANES - 1, Math.round(pt.x / LANE_W + 3)));
}
let drag = null;
addEventListener('pointerdown', e => {
  if (G.state === 'end' || (e.target.closest && e.target.closest('#end'))) return;
  drag = { x0: e.clientX, moved: false };
});
addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.moved && Math.abs(e.clientX - drag.x0) > 12) drag.moved = true;
  if (drag.moved) G.lane = laneFromClientX(e.clientX, e.clientY);
});
addEventListener('pointerup', e => {
  if (!drag) return;
  const wasTap = !drag.moved;
  drag = null;
  if (wasTap && G.state !== 'end') {
    if (e.clientX < innerWidth / 2) G.lane = Math.max(0, G.lane - 1);
    else G.lane = Math.min(LANES - 1, G.lane + 1);
  }
});
document.getElementById('replay').addEventListener('click', () => location.reload());

// autopilot (testing/demo): hop toward the closest green cube, dodge reds
let apCool = 0;
function autopilot(dt) {
  apCool -= dt;
  if (apCool > 0) return;
  let target = null, bestY = Infinity;
  for (const c of G.cubes) if (c.state === 'fall' && !c.red && c.y < bestY) { bestY = c.y; target = c.lane; }
  if (target === null) { const nq = G.spawnQ.find(q => !q.red); if (nq) target = nq.lane; }
  const danger = G.cubes.some(c => c.state === 'fall' && c.red && c.lane === G.lane && c.y < PADDLE_TOP + 2.5);
  if (danger && (target === null || target === G.lane)) target = G.lane + (G.lane < LANES - 1 ? 1 : -1);
  if (target === null || target === G.lane) return;
  G.lane += Math.sign(target - G.lane);
  apCool = 0.09;
}

// ---- timeline strip ------------------------------------------------------
const tl = document.getElementById('timeline');
const tctx = tl.getContext('2d');
const TL_H = 74;
function drawTimeline() {
  const dpr = Math.min(devicePixelRatio, 2);
  if (tl.width !== innerWidth * dpr) { tl.width = innerWidth * dpr; tl.height = TL_H * dpr; }
  tl.style.width = innerWidth + 'px'; tl.style.height = TL_H + 'px';
  const ctx = tctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, innerWidth, TL_H);
  ctx.fillStyle = 'rgba(13,17,23,.92)';
  ctx.fillRect(0, 0, innerWidth, TL_H);
  ctx.strokeStyle = '#21262d';
  ctx.beginPath(); ctx.moveTo(0, 0.5); ctx.lineTo(innerWidth, 0.5); ctx.stroke();

  const n = weeks.length;
  const pad = 14, W = innerWidth - pad * 2, barW = W / n;
  const maxT = Math.max(...weeks.map(weekTotal), 1);
  const baseY = TL_H - 18, maxH = TL_H - 30;
  let lastYear = '';
  for (let i = 0; i < n; i++) {
    const t = weekTotal(weeks[i]);
    const x = pad + i * barW;
    const y = weeks[i].s.slice(0, 4);
    if (y !== lastYear) {
      lastYear = y;
      ctx.fillStyle = '#8b949e'; ctx.font = '10px sans-serif';
      ctx.fillText(y, x, TL_H - 5);
      ctx.strokeStyle = '#21262d';
      ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, baseY); ctx.stroke();
    }
    if (t === 0) continue;
    const h = Math.max(2, Math.sqrt(t / maxT) * maxH);
    const played = i < G.playhead;
    if (played) {
      const frac = Math.min(1, G.perWeekCollected[i] / t);
      ctx.fillStyle = '#1c4a2c';
      ctx.fillRect(x, baseY - h, Math.max(1, barW - 0.5), h);
      ctx.fillStyle = '#39d353';
      ctx.fillRect(x, baseY - h * frac, Math.max(1, barW - 0.5), h * frac);
    } else {
      ctx.fillStyle = '#274a33';
      ctx.fillRect(x, baseY - h, Math.max(1, barW - 0.5), h);
    }
  }
  // playhead
  const px = pad + Math.min(G.playhead, n) * barW;
  ctx.fillStyle = '#58a6ff';
  ctx.fillRect(px - 1, 4, 2, baseY - 4);
  ctx.beginPath(); ctx.arc(px, 6, 3.5, 0, Math.PI * 2); ctx.fill();
}

// ---- main loop -----------------------------------------------------------
function resize() {
  renderer.setSize(innerWidth, innerHeight - 8);
  camera.aspect = innerWidth / (innerHeight - 8);
  // Keep all 7 lanes in view on narrow (portrait phone) screens: hold the
  // horizontal field of view steady and let the vertical fov grow as needed.
  const HFOV = 1.34; // ~77 degrees, fits the lane strip with margin
  const v = 2 * Math.atan(Math.tan(HFOV / 2) / camera.aspect) * 180 / Math.PI;
  camera.fov = Math.min(100, Math.max(55, v));
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (G.paused) { renderer.render(scene, camera); return; }
  dt *= URL_SPEED;

  if (AUTOPILOT && G.state === 'week') autopilot(dt);

  // state machine
  if (G.state === 'card') {
    G.cardT += dt;
    if (G.cardT >= G.cardDur) { card.classList.remove('show'); G.ei++; startEvent(); }
  } else if (G.state === 'week') {
    G.weekT += dt;
    while (G.spawnQ.length && G.spawnQ[0].t <= G.weekT) spawnCube(G.spawnQ.shift());
    if (!G.spawnQ.length && !G.cubes.some(c => c.state === 'fall') && G.weekT > 1) {
      G.ei++; startEvent();
    }
  }

  // playhead easing toward target (sweeps during gap/year cards)
  G.playhead += (G.playheadTarget - G.playhead) * Math.min(1, dt * 6);

  // paddle
  const targetX = laneX(G.lane);
  paddleSpring.v += ((targetX - paddle.position.x) * 180 - paddleSpring.v * 16) * dt;
  paddle.position.x += paddleSpring.v * dt;
  spring(paddleSquash, dt, 160, 10);
  paddle.scale.set(2 - Math.min(paddleSquash.x, 1.4), paddleSquash.x, 2 - Math.min(paddleSquash.x, 1.4));
  paddle.scale.x = Math.max(0.6, Math.min(paddle.scale.x, 1.5));
  paddle.scale.z = paddle.scale.x;
  for (let i = 0; i < LANES; i++) {
    laneMats[i].color.set(i === G.lane ? '#1c2530' : '#161b22');
    dayLabelMats[i].opacity = i === G.lane ? 0.9 : 0.35;
    dayLabelMats[i].color.set(i === G.lane ? '#e6edf3' : '#8b949e');
  }

  // cubes
  for (let i = G.cubes.length - 1; i >= 0; i--) {
    const c = G.cubes[i];
    c.mat.userData.uT.value += dt;
    spring(c.sx, dt, 140, 9); spring(c.sy, dt, 140, 9); spring(c.sz, dt, 140, 9);
    if (c.state === 'fall') {
      c.y -= FALL_SPEED * dt;
      const bottom = c.y - c.h / 2;
      if (bottom <= PADDLE_TOP && bottom > PADDLE_TOP - 0.3 && c.lane === G.lane) catchCube(c);
      else if (bottom <= 0.02) missCube(c);
    } else {
      c.t += dt;
      if (c.state === 'caught') {
        c.fade = Math.max(0, 1 - c.t / 0.3);
        c.y = Math.max(c.y - FALL_SPEED * dt * 0.3, PADDLE_TOP + c.h / 2 * c.fade);
      } else { // missed: splat, sink, fade
        c.fade = Math.max(0, 1 - c.t / 0.9);
        c.y = c.h / 2 * Math.max(c.sy.x, 0.25);
      }
      if (c.fade <= 0) {
        scene.remove(c.mesh); c.mat.dispose();
        G.cubes.splice(i, 1);
        continue;
      }
    }
    const sc = c.state === 'caught' ? 0.4 + 0.6 * c.fade : 1;
    c.mesh.position.set(laneX(c.lane), c.y, 0);
    c.mesh.scale.set(
      Math.max(0.25, c.f * c.sx.x * sc),
      Math.max(0.15, c.h * c.sy.x * sc),
      Math.max(0.25, c.f * c.sz.x * sc)
    );
    c.mat.opacity = 0.94 * c.fade;
  }

  // score rolling counter
  if (G.displayScore !== G.score) {
    const diff = G.score - G.displayScore;
    const step = diff * Math.min(1, dt * 10);
    G.displayScore += diff > 0 ? Math.ceil(step) : Math.floor(step); // round away from zero so -1 registers
    scoreN.textContent = G.displayScore.toLocaleString();
    scoreN.style.transform = 'scale(1.12)';
  } else scoreN.style.transform = 'scale(1)';

  drawTimeline();
  renderer.render(scene, camera);
}

startEvent();
requestAnimationFrame(frame);

// test/debug handle
window.__play = {
  get score() { return G.score; }, get state() { return G.state; },
  get caught() { return G.caught; }, get missed() { return G.missed; }, get reds() { return G.reds; },
  get lane() { return G.lane; }, set lane(v) { G.lane = v; },
  get eventIndex() { return G.ei; }, get cubes() { return G.cubes; },
  get displayScore() { return G.displayScore; }, events, weeks, grandTotal,
};
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); return; }
  const login = resolveUsername(opts.username);
  console.log(`Fetching contribution calendar for ${login}…`);
  const { dayMap, repoDay } = fetchCalendar(login, opts);
  const built = buildWeeks(dayMap);
  if (!built) fail(`No contributions found for ${login}.`);
  const { weeks, yearStats } = built;

  // Attach each week's top repos (by commits) for the in-game label.
  const byWeek = {};
  for (const [date, repo, commits] of repoDay) {
    const ws = weekStart(date);
    (byWeek[ws] = byWeek[ws] || {})[repo] = (byWeek[ws][repo] || 0) + commits;
  }
  const shortName = r => r.toLowerCase().startsWith(login.toLowerCase() + '/') ? r.slice(login.length + 1) : r;
  for (const w of weeks) {
    const m = byWeek[w.s];
    if (m) w.r = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r]) => shortName(r));
  }
  const grandTotal = Object.values(yearStats).reduce((a, y) => a + y.total, 0);

  const html = renderHTML({ login, weeks, years: yearStats });
  const outFile = opts.output ? path.resolve(opts.output) : path.join(CACHE_DIR, `${login}-play.html`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html);
  console.log(`\n${grandTotal.toLocaleString()} contributions across ${weeks.length} weeks. Wrote ${outFile}`);
  if (opts.open) openInBrowser(outFile);
}

module.exports = { main };
