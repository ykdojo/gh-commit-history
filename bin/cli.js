#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Styles (matching GitHub's dark theme palette, same as gh-star-history)
// ---------------------------------------------------------------------------
const STYLES = {
  blue: { accent: '#58a6ff', line: '#79c0ff' },
  green: { accent: '#3fb950', line: '#56d364' },
  purple: { accent: '#bc8cff', line: '#d2a8ff' },
};

const CACHE_DIR = path.join(os.homedir(), '.gh-commit-history');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    username: null,
    years: null, // null = all history since account creation
    granularity: 'weekly',
    style: 'blue',
    output: null,
    open: true,
    cache: true,
    includePrivate: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--years') opts.years = parseInt(argv[++i], 10);
    else if (a === '--granularity' || a === '-g') opts.granularity = argv[++i];
    else if (a === '--style') opts.style = argv[++i];
    else if (a === '--output' || a === '-o') opts.output = argv[++i];
    else if (a === '--no-open') opts.open = false;
    else if (a === '--no-cache') opts.cache = false;
    else if (a === '--exclude-private' || a === '--no-private') opts.includePrivate = false;
    else if (a.startsWith('-')) fail(`Unknown option: ${a}`);
    else opts.username = a.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  }
  return opts;
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const HELP = `
gh-commit-history - visualize your GitHub commit history across years

Usage:
  npx gh-commit-history [username] [options]

  Defaults to your authenticated GitHub user if no username is given.

Options:
  --years <n>          Limit to the past n years (default: all history since account creation)
  -g, --granularity    daily | weekly | monthly (default: weekly)
  --style <name>       blue (default) | green | purple
  -o, --output <path>  Output HTML path (default: commit-history.html)
  --exclude-private    Exclude private repositories (private are included by default)
  --no-open            Don't auto-open the browser
  --no-cache           Skip cache, fetch everything fresh
  -h, --help           Show this help

Examples:
  npx gh-commit-history
  npx gh-commit-history ykdojo --years 6 -g monthly
  npx gh-commit-history torvalds --style green -o linus.html
`;

// ---------------------------------------------------------------------------
// gh CLI helpers
// ---------------------------------------------------------------------------
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

function accountCreatedAt(login) {
  const out = gh(['api', `users/${login}`, '--jq', '.created_at']).trim();
  return out ? new Date(out) : null;
}

// ---------------------------------------------------------------------------
// Commit search (includes private repos; the contributions API does not itemize those)
// ---------------------------------------------------------------------------
// The search API caps at 30 requests/min and 1000 results per query. We throttle
// to stay under the rate limit and recursively split any date range that exceeds
// 1000 results, so every commit-day is captured regardless of activity level.
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.ceil(ms));
}

// Live progress line (rewritten in place) so long rate-limit waits don't look frozen.
let progressLabel = '';
function progress(msg) { if (progressLabel) process.stdout.write(`\r  ${progressLabel}: ${msg}\x1b[K`); }
function rateLimitWait() { for (let s = 60; s > 0; s--) { progress(`rate limited - resuming in ${s}s`); sleepSync(1000); } }

// The search API's *secondary* rate limit punishes bursts, so we space every
// request ~3s apart and back off 60s on a 403 instead of failing.
let lastSearch = 0;
const SEARCH_GAP = 3000;
function searchPage(login, from, to, page) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = lastSearch + SEARCH_GAP - Date.now();
    if (wait > 0) sleepSync(wait);
    lastSearch = Date.now();
    try {
      const raw = execFileSync('gh', [
        'api', '-X', 'GET', 'search/commits',
        '-f', `q=author:${login} author-date:${from}..${to}`,
        '-f', 'per_page=100', '-f', `page=${page}`,
        '-f', 'sort=author-date', '-f', 'order=desc',
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const json = JSON.parse(raw);
      if (json.message && json.total_count === undefined) {
        if (/rate limit/i.test(json.message)) { rateLimitWait(); continue; }
        fail(`Search API error: ${json.message}`);
      }
      return json;
    } catch (e) {
      if (e.code === 'ENOENT') fail('GitHub CLI (gh) not found. Install from https://cli.github.com/ and run `gh auth login`.');
      const msg = (e.stderr || '').toString() || e.message || '';
      if (/rate limit/i.test(msg) || /HTTP 403/.test(msg)) { rateLimitWait(); continue; }
      fail(`gh command failed: ${msg}`);
    }
  }
  fail('Repeatedly rate-limited by the search API. Try again in a few minutes.');
}

function midDate(from, to) {
  const a = new Date(from + 'T00:00:00Z').getTime();
  const b = new Date(to + 'T00:00:00Z').getTime();
  return ymd(new Date(a + Math.floor((b - a) / 2)));
}

// Returns { commits: [{repo, date, owner, fork, priv}], truncated }
// SHA-deduped (canonical copy kept) but not otherwise filtered, so main() can
// re-aggregate under different filters without refetching.
function fetchWindow(login, fromISO, toISO) {
  const from = fromISO.slice(0, 10), to = toISO.slice(0, 10);
  const raw = []; // { sha, repo, date, fork, owner, priv }
  let truncated = false;

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
    const first = searchPage(login, f, t, 1);
    const count = first.total_count || 0;
    if (count === 0) return;
    if (count > 1000) {
      const mid = midDate(f, t);
      if (mid <= f || mid >= t) { collect(first.items); truncated = true; return; } // single day > 1000: accept
      range(f, mid);
      range(ymd(new Date(new Date(mid + 'T00:00:00Z').getTime() + 86400000)), t);
      return;
    }
    collect(first.items);
    progress(`${raw.length} commits...`);
    const pages = Math.ceil(count / 100);
    for (let p = 2; p <= pages; p++) { collect(searchPage(login, f, t, p).items); progress(`${raw.length} commits...`); }
  }

  range(from, to);

  // The same commit appears in every fork (same SHA). Keep one canonical copy -
  // prefer a repo the user owns, then a non-fork. A fork that merely copies your
  // commits collapses into the canonical repo and disappears; a fork where you
  // authored *unique* commits keeps those (their SHAs exist nowhere else).
  const score = (it) => (it.owner === login ? 2 : 0) + (it.fork ? 0 : 1);
  const bySha = new Map();
  for (const it of raw) { const cur = bySha.get(it.sha); if (!cur || score(it) > score(cur)) bySha.set(it.sha, it); }

  const commits = [...bySha.values()].map((it) => ({ repo: it.repo, date: it.date, owner: it.owner, fork: it.fork, priv: it.priv }));
  return { commits, truncated };
}

// ---------------------------------------------------------------------------
// Date / window helpers (all in UTC for stable bucketing)
// ---------------------------------------------------------------------------
function ymd(d) { return d.toISOString().slice(0, 10); }

// Quarters covering [startDate, endDate]. We fetch whole quarters (the quarter
// containing startDate may begin slightly earlier); the display range clips back
// to the exact rolling window.
function quarterWindows(startDate, endDate) {
  const windows = [];
  let y = startDate.getUTCFullYear();
  let q = Math.floor(startDate.getUTCMonth() / 3);
  for (;;) {
    const from = new Date(Date.UTC(y, q * 3, 1, 0, 0, 0));
    if (from > endDate) break;
    const to = new Date(Date.UTC(y, q * 3 + 3, 0, 23, 59, 59)); // last day of quarter
    windows.push({
      key: `${y}-Q${q + 1}`,
      from: from.toISOString(),
      to: to.toISOString(),
      isCurrent: endDate >= from && endDate <= to,
    });
    q++;
    if (q > 3) { q = 0; y++; }
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Cache (per-window, so only the current quarter is refetched)
// ---------------------------------------------------------------------------
function cachePath(login) { return path.join(CACHE_DIR, `${login}.json`); }

function loadCache(login) {
  try { return JSON.parse(fs.readFileSync(cachePath(login), 'utf8')); }
  catch { return { windows: {} }; }
}

function saveCache(login, cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(login), JSON.stringify(cache));
}

// ---------------------------------------------------------------------------
// HTML rendering (aggregation happens client-side so the granularity toggle is live)
// ---------------------------------------------------------------------------
function renderHTML({ login, daily, repoDaily, defaultGranularity, style, total, rangeStart, rangeEnd }) {
  const colors = STYLES[style] || STYLES.blue;
  const payload = { login, daily, repoDaily, defaultGranularity, accent: colors.accent, total, rangeStart, rangeEnd };

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${login} commit history</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .container{max-width:1200px;margin:0 auto;padding:24px 20px}
  h1{text-align:center;font-size:22px;margin:8px 0 4px;color:#e6edf3}
  .subtitle{text-align:center;color:#8b949e;font-size:14px;margin-bottom:20px}
  #controls{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;margin-bottom:16px}
  #controls .label{margin:0 4px 0 12px;font-size:13px;color:#8b949e}
  #controls .label:first-child{margin-left:0}
  #controls button{background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer}
  #controls button:hover{border-color:${colors.accent}}
  #controls button.active{background:${colors.accent};border-color:${colors.accent};color:#0d1117;font-weight:600}
  #controls select,#controls input{background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:6px 10px;font-size:13px;font-family:inherit;outline:none}
  #controls select:hover,#controls input:hover{border-color:${colors.accent}}
  #controls #topn{width:56px;text-align:center}
  #controls input[type=date]{color-scheme:dark}
  .chart{width:100%;height:380px;margin-bottom:24px}
  .footer{text-align:center;color:#484f58;font-size:12px;margin-top:8px}
  .footer code{background:#161b22;padding:2px 6px;border-radius:4px;font-size:11px}
</style>
</head><body>
<div class="container">
  <h1>${login} - commit history</h1>
  <div class="subtitle" id="subtitle">${total.toLocaleString()} commits · ${rangeStart} to ${rangeEnd}</div>
  <div id="controls">
    <span class="label">Granularity:</span>
    <button data-g="daily">Daily</button>
    <button data-g="weekly">Weekly</button>
    <button data-g="monthly">Monthly</button>
    <span class="label">Range:</span>
    <select id="range-mode">
      <option value="all">All time</option>
      <option value="past">Past...</option>
      <option value="custom">Custom range</option>
    </select>
    <select id="past-select" style="display:none">
      <option value="1w">1 week</option>
      <option value="1m">1 month</option>
      <option value="3m">3 months</option>
      <option value="6m">6 months</option>
      <option value="1y">1 year</option>
      <option value="2y">2 years</option>
      <option value="3y">3 years</option>
      <option value="4y">4 years</option>
      <option value="5y">5 years</option>
      <option value="10y">10 years</option>
      <option value="20y">20 years</option>
    </select>
    <span id="custom-range" style="display:none">
      <input type="date" id="start-date"><span class="label">to</span><input type="date" id="end-date">
    </span>
    <span class="label">Top repos:</span>
    <input type="number" id="topn" min="1" value="20" autocomplete="off">
  </div>
  <div id="chart" class="chart"></div>
  <div id="repo-chart" class="chart"></div>
  <div id="repo-totals-chart" style="width:100%;margin-bottom:24px"></div>
  <div class="footer">Generated by <code>npx gh-commit-history ${login}</code></div>
</div>
<script>
const D = ${JSON.stringify(payload)};
const PALETTE=['#5B8FF9','#E8684A','#5AD8A6','#F6BD16','#6DC8EC','#9270CA','#F08BB4','#7DD1B3','#E8A65D','#78D3F8','#D4E157','#FF8A65','#4DD0E1','#BA68C8','#A1887F','#90A4AE','#F48FB1','#80CBC4','#FFD54F','#CE93D8','#AED581','#4FC3F7','#FF7043','#7986CB','#FFF176','#E57373','#81C784','#64B5F6','#FFB74D','#9575CD'];
const OTHER_COLOR='#5D7092';
const cfg={responsive:true,displaylogo:false};

function ymd(d){return d.toISOString().slice(0,10);}
function addDays(s,n){const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return ymd(d);}
function subYears(s,n){const d=new Date(s+'T00:00:00Z');d.setUTCFullYear(d.getUTCFullYear()-n);return ymd(d);}
function subMonths(s,n){const d=new Date(s+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()-n);return ymd(d);}
function weekStart(s){const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-d.getUTCDay());return ymd(d);} // Sunday
function keyFor(date,g){if(g==='daily')return date;if(g==='monthly')return date.slice(0,7)+'-01';return weekStart(date);}

const ALL_DATES=(function(){const out=[];let d=D.rangeStart;while(d<=D.rangeEnd){out.push(d);d=addDays(d,1);}return out;})();

// Ordered bucket keys + index map per granularity (cached)
const bucketCache={};
function buckets(g){
  if(bucketCache[g])return bucketCache[g];
  const order=[],idx={},seen=new Set();
  for(const date of ALL_DATES){const k=keyFor(date,g);if(!seen.has(k)){seen.add(k);order.push(k);}}
  order.forEach((k,i)=>{idx[k]=i;});
  return (bucketCache[g]={order,idx});
}
// Sum a {date:count} map into a y-array aligned to buckets(g).order
function seriesFor(dateMap,g){
  const b=buckets(g),y=new Array(b.order.length).fill(0);
  for(const date in dateMap){if(date<D.rangeStart||date>D.rangeEnd)continue;y[b.idx[keyFor(date,g)]]+=dateMap[date];}
  return y;
}

// Rank repos by commits within [vs,ve]
function rankRepos(vs,ve){
  return Object.keys(D.repoDaily).map(repo=>{
    const rd=D.repoDaily[repo];let t=0;
    for(const date in rd){if(date>=vs&&date<=ve)t+=rd[date];}
    return {repo,t};
  }).filter(x=>x.t>0).sort((a,b)=>b.t-a.t);
}

// Stable colors by all-time rank
const colorByRepo={Other:OTHER_COLOR},allRankIndex={};
rankRepos(D.rangeStart,D.rangeEnd).forEach((x,i)=>{colorByRepo[x.repo]=PALETTE[i%PALETTE.length];allRankIndex[x.repo]=i;});

function yearBands(){
  const ys={};ALL_DATES.forEach(d=>{ys[d.slice(0,4)]=1;});
  return Object.keys(ys).sort().map((y,i)=>({type:'rect',xref:'x',yref:'paper',
    x0:y+'-01-01',x1:y+'-12-31',y0:0,y1:1,
    fillcolor:i%2===0?'rgba(255,255,255,0.03)':'rgba(255,255,255,0)',line:{width:0},layer:'below'}));
}

const granLabel={daily:'per day',weekly:'per week',monthly:'per month'};
let g=D.defaultGranularity, topN=20, currentRange='all', customRange=[D.rangeStart,D.rangeEnd];

function pastRange(key){
  if(key.endsWith('y'))return [subYears(D.rangeEnd,parseInt(key)),D.rangeEnd];
  if(key.endsWith('w'))return [addDays(D.rangeEnd,-7*parseInt(key)),D.rangeEnd];
  return [subMonths(D.rangeEnd,parseInt(key)),D.rangeEnd];
}
function visibleRange(){
  if(currentRange==='all')return [D.rangeStart,D.rangeEnd];
  if(currentRange==='custom')return customRange;
  return pastRange(currentRange);
}
// Pick a sensible granularity for the visible span: daily for short ranges, weekly for up to ~3 years, else monthly.
function autoGran(){
  const [vs,ve]=visibleRange();
  const days=(new Date(ve)-new Date(vs))/864e5;
  return days<=45?'daily':days<=1100?'weekly':'monthly';
}
function applyRangeChange(){
  g=autoGran();
  document.querySelectorAll('#controls button[data-g]').forEach(x=>x.classList.toggle('active',x.dataset.g===g));
  renderAll();
}

function baseLayout(yTitle){
  return {paper_bgcolor:'#0d1117',plot_bgcolor:'#0d1117',font:{color:'#c9d1d9'},
    xaxis:{gridcolor:'#21262d',type:'date'},
    yaxis:{title:yTitle,gridcolor:'#21262d',rangemode:'tozero'},
    bargap:0.15,shapes:yearBands(),margin:{t:36,r:20,b:36,l:55}};
}

// Per-bucket top-5 repos, for the total chart's hover breakdown
function topReposPerBucket(g){
  const b=buckets(g),acc=b.order.map(()=>({}));
  for(const repo in D.repoDaily){
    const rd=D.repoDaily[repo];
    for(const date in rd){if(date<D.rangeStart||date>D.rangeEnd)continue;const i=b.idx[keyFor(date,g)];acc[i][repo]=(acc[i][repo]||0)+rd[date];}
  }
  return acc.map(m=>Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,5));
}

function renderTotal(){
  const x=buckets(g).order,y=seriesFor(D.daily,g),tops=topReposPerBucket(g);
  const text=x.map((k,i)=>{
    const lines=tops[i].map(e=>'&nbsp;&nbsp;'+e[0]+': '+e[1]).join('<br>');
    return '<b>'+k+'</b><br>'+y[i]+' commits'+(tops[i].length?'<br>Top repos:<br>'+lines:'');
  });
  const layout=baseLayout('commits '+granLabel[g]);
  layout.title={text:'Total commits '+granLabel[g],font:{size:15},x:0,xanchor:'left'};
  Plotly.react('chart',[{type:'bar',x:x,y:y,marker:{color:D.accent},hovertext:text,hovertemplate:'%{hovertext}<extra></extra>'}],layout,cfg);
}

function renderRepos(){
  const [vs,ve]=visibleRange();
  const b=buckets(g),x=b.order;

  // Per-bucket repo counts within the visible range.
  const perBucket=x.map(()=>({}));
  for(const repo in D.repoDaily){
    const rd=D.repoDaily[repo];
    for(const date in rd){if(date<vs||date>ve)continue;const i=b.idx[keyFor(date,g)];perBucket[i][repo]=(perBucket[i][repo]||0)+rd[date];}
  }

  // Rank PER BUCKET: each bucket shows its own top-N repos; the rest of that bucket -> Other.
  // This way a repo can never hide in "Other" while being a bucket's top contributor.
  const named=new Set();
  const namedY={}, otherY=new Array(x.length).fill(null), otherText=new Array(x.length).fill(null);
  const ensure=r=>{if(!namedY[r]){namedY[r]=new Array(x.length).fill(null);named.add(r);}};
  perBucket.forEach((m,i)=>{
    const entries=Object.entries(m).sort((a,c)=>c[1]-a[1]);
    entries.slice(0,topN).forEach(e=>{ensure(e[0]);namedY[e[0]][i]=e[1];});
    const rest=entries.slice(topN);
    if(rest.length){
      const tot=rest.reduce((s,e)=>s+e[1],0);
      otherY[i]=tot;
      const shown=rest.slice(0,10).map(e=>'&nbsp;&nbsp;'+e[0]+': '+e[1]).join('<br>');
      let txt='<b>other</b>: '+tot+' commits ('+rest.length+(rest.length===1?' repo)':' repos)')+'<br>'+shown;
      const more=rest.slice(10);
      if(more.length){const mt=more.reduce((s,e)=>s+e[1],0);txt+='<br>&nbsp;&nbsp;...and '+more.length+' more ('+mt+')';}
      otherText[i]=txt;
    }
  });

  // Order named repos by all-time rank for stable stack layering & colors.
  const order=[...named].sort((a,c)=>(allRankIndex[a]==null?1e9:allRankIndex[a])-(allRankIndex[c]==null?1e9:allRankIndex[c]));
  const display=order.concat(otherY.some(v=>v!=null)?['other']:[]);
  // largest at bottom: add in reverse display order
  const traces=display.slice().reverse().map(repo=>{
    if(repo==='other')return {type:'bar',x:x,y:otherY,name:'other',marker:{color:OTHER_COLOR},hovertext:otherText,hovertemplate:'%{hovertext}<extra></extra>'};
    return {type:'bar',x:x,y:namedY[repo],name:repo,marker:{color:colorByRepo[repo]||OTHER_COLOR},hovertemplate:repo+': %{y} commits<extra></extra>'};
  });
  const layout=baseLayout('commits '+granLabel[g]);
  layout.barmode='stack';
  layout.hovermode='x unified';
  layout.hoverlabel={align:'left',bgcolor:'#161b22',bordercolor:'#30363d',font:{size:12}};
  layout.title={text:'By repository - top '+topN+' '+granLabel[g]+' ('+order.length+' repos shown)',font:{size:15},x:0,xanchor:'left'};
  layout.showlegend=false; // membership varies per bucket; the hover names each segment, overall chart is the color key
  layout.margin.r=30;
  Plotly.react('repo-chart',traces,layout,cfg);
}

// Overall breakdown: horizontal bars of top-N repos + Other (with % labels and Other-hover) for the visible range
function renderTotals(){
  const [vs,ve]=visibleRange();
  const ranked=rankRepos(vs,ve);
  const top=ranked.slice(0,topN);
  const others=ranked.slice(topN);
  const items=top.map(x=>({repo:x.repo,total:x.t}));
  let otherTotal=0;const otherBreakdown=others.slice();
  others.forEach(x=>{otherTotal+=x.t;});
  if(otherTotal>0)items.push({repo:'other',total:otherTotal});
  // other at the bottom, then ascending so the largest repo sits at the top
  items.sort((a,b)=>{if(a.repo==='other')return -1;if(b.repo==='other')return 1;return a.total-b.total;});
  const grand=items.reduce((s,i)=>s+i.total,0)||1;
  let otherHover='';
  if(otherBreakdown.length){
    const shown=otherBreakdown.slice(0,20),rest=otherBreakdown.slice(20);
    otherHover='<b>other</b>: '+otherTotal+' commits ('+otherBreakdown.length+(otherBreakdown.length===1?' repo)':' repos)')+'<br>'+shown.map(e=>'&nbsp;&nbsp;'+e.repo+': '+e.t).join('<br>');
    if(rest.length){const rt=rest.reduce((s,e)=>s+e.t,0);otherHover+='<br>&nbsp;&nbsp;...and '+rest.length+' more ('+rt+')';}
  }
  const hover=items.map(i=>i.repo==='other'?otherHover:'<b>'+i.repo+'</b>: '+i.total+' commits ('+(i.total/grand*100).toFixed(1)+'%)');
  const trace={type:'bar',orientation:'h',y:items.map(i=>i.repo),x:items.map(i=>i.total),
    marker:{color:items.map(i=>colorByRepo[i.repo]||OTHER_COLOR)},
    text:items.map(i=>(i.total/grand*100).toFixed(1)+'%'),textposition:'outside',textfont:{color:'#8b949e',size:11},
    hovertext:hover,hovertemplate:'%{hovertext}<extra></extra>'};
  const layout={paper_bgcolor:'#0d1117',plot_bgcolor:'#0d1117',font:{color:'#c9d1d9'},
    title:{text:'Overall breakdown by repository ('+vs+' to '+ve+')',font:{size:15},x:0,xanchor:'left'},
    xaxis:{title:'commits',gridcolor:'#21262d',rangemode:'tozero'},yaxis:{automargin:true,ticksuffix:'  '},
    margin:{t:40,r:60,b:40,l:10},height:Math.max(240,items.length*26+100),showlegend:false};
  Plotly.react('repo-totals-chart',[trace],layout,cfg);
}

function applyZoom(){
  const r=currentRange==='all'?{'xaxis.autorange':true}:{'xaxis.autorange':false,'xaxis.range':visibleRange()};
  Plotly.relayout('chart',r);Plotly.relayout('repo-chart',r);
}

function updateSubtitle(){
  const [vs,ve]=visibleRange();
  let vt=0;for(const date in D.daily){if(date>=vs&&date<=ve)vt+=D.daily[date];}
  document.getElementById('subtitle').textContent=vt.toLocaleString()+' commits · '+vs+' to '+ve;
}
function renderAll(){updateSubtitle();renderTotal();renderRepos();renderTotals();applyZoom();}

document.querySelectorAll('#controls button[data-g]').forEach(b=>b.addEventListener('click',()=>{
  g=b.dataset.g;
  document.querySelectorAll('#controls button[data-g]').forEach(x=>x.classList.toggle('active',x===b));
  renderAll();
}));
document.getElementById('topn').addEventListener('change',e=>{topN=Math.max(1,parseInt(e.target.value)||1);renderRepos();renderTotals();applyZoom();});

// Range: All time / Past... (sub-dropdown) / Custom range (date pickers), like gh-star-history
const rangeMode=document.getElementById('range-mode');
const pastSelect=document.getElementById('past-select');
const customSpan=document.getElementById('custom-range');
const startInput=document.getElementById('start-date');
const endInput=document.getElementById('end-date');

// Hide past options longer than the available data span; default to the longest visible.
const spanMs=new Date(D.rangeEnd).getTime()-new Date(D.rangeStart).getTime();
const PERIOD_MS={'20y':20*365,'10y':10*365,'5y':5*365,'4y':4*365,'3y':3*365,'2y':2*365,'1y':365,'6m':182,'3m':91,'1m':30,'1w':7};
let defaultPast=null,defMs=0;
pastSelect.querySelectorAll('option').forEach(opt=>{
  const ms=PERIOD_MS[opt.value]*864e5;
  if(ms>spanMs*1.02)opt.style.display='none';
  else if(ms>defMs){defMs=ms;defaultPast=opt.value;}
});
if(defaultPast)pastSelect.value=defaultPast;
startInput.min=endInput.min=D.rangeStart;startInput.max=endInput.max=D.rangeEnd;
startInput.value=D.rangeStart;endInput.value=D.rangeEnd;

// Default view: past 2 years (fall back to all time for younger accounts)
if(spanMs>=2*365*864e5){
  currentRange='2y';
  rangeMode.value='past';
  pastSelect.value='2y';
  pastSelect.style.display='inline-block';
}

rangeMode.addEventListener('change',function(){
  pastSelect.style.display=this.value==='past'?'inline-block':'none';
  customSpan.style.display=this.value==='custom'?'inline':'none';
  if(this.value==='past')currentRange=pastSelect.value;
  else if(this.value==='custom'){customRange=[startInput.value,endInput.value];currentRange='custom';}
  else currentRange='all';
  applyRangeChange();
});
pastSelect.addEventListener('change',function(){currentRange=this.value;applyRangeChange();});
[startInput,endInput].forEach(inp=>inp.addEventListener('change',()=>{
  if(startInput.value&&endInput.value){customRange=[startInput.value,endInput.value];currentRange='custom';applyRangeChange();}
}));

document.querySelector('#controls button[data-g="'+g+'"]').classList.add('active');
topN=Math.max(1,parseInt(document.getElementById('topn').value)||20); // sync with input in case the browser restored a value
renderAll();
</script></body></html>`;
}

function openInBrowser(file) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { execFileSync(cmd, [file], { stdio: 'ignore' }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  if (!['daily', 'weekly', 'monthly'].includes(opts.granularity)) fail(`Invalid granularity: ${opts.granularity}`);
  if (opts.years !== null && (!Number.isInteger(opts.years) || opts.years < 1)) fail('--years must be a positive integer');

  const login = resolveUsername(opts.username);

  // Default to the account's full history; --years N limits to a rolling window.
  const end = new Date();
  let start;
  if (opts.years !== null) {
    start = new Date(Date.UTC(end.getUTCFullYear() - opts.years, end.getUTCMonth(), end.getUTCDate()));
    console.log(`Fetching commit history for ${login} (past ${opts.years} year${opts.years > 1 ? 's' : ''})...`);
  } else {
    start = accountCreatedAt(login) || new Date(Date.UTC(end.getUTCFullYear() - 10, end.getUTCMonth(), end.getUTCDate()));
    console.log(`Fetching commit history for ${login} (all history since ${ymd(start)})...`);
  }
  const rangeStart = ymd(start);
  const rangeEnd = ymd(end);

  const cache = opts.cache ? loadCache(login) : { windows: {} };
  const windows = quarterWindows(start, end);
  const allRepoDaily = {};
  const privateRepos = new Set();
  let anyTruncated = false;

  if (windows.some((w) => !cache.windows[w.key] || w.isCurrent || !opts.cache)) {
    console.log('  (Uses the rate-limited commit search API, so this can take a few minutes the first time. Progress is cached per quarter - safe to stop and resume.)');
  }

  for (const w of windows) {
    let res = cache.windows[w.key];
    const needFetch = !res || w.isCurrent || !opts.cache;
    if (needFetch) {
      progressLabel = w.key;
      progress('fetching...');
      res = fetchWindow(login, w.from, w.to);
      cache.windows[w.key] = res;
      process.stdout.write(`\r  ${w.key}: ${res.commits.length} commits\x1b[K\n`);
      progressLabel = '';
      if (opts.cache) saveCache(login, cache); // save incrementally; the search fetch is slow (rate-limited)
    } else {
      console.log(`  ${w.key}: ${res.commits.length} commits (cached)`);
    }
    for (const c of res.commits) {
      if (c.priv) privateRepos.add(c.repo);
      allRepoDaily[c.repo] = allRepoDaily[c.repo] || {};
      allRepoDaily[c.repo][c.date] = (allRepoDaily[c.repo][c.date] || 0) + 1;
    }
    if (res.truncated) anyTruncated = true;
  }

  if (opts.cache) saveCache(login, cache);
  if (anyTruncated) console.warn('  Note: some single days had >1000 commits; counts may be slightly under-reported.');

  // Clip fetched data to the exact window and derive the daily totals from per-repo.
  const inRange = (d) => d >= rangeStart && d <= rangeEnd;
  const daily = {};
  const repoDaily = {};
  for (const [repo, obj] of Object.entries(allRepoDaily)) {
    if (!opts.includePrivate && privateRepos.has(repo)) continue;
    const o = {};
    for (const [date, n] of Object.entries(obj)) if (inRange(date)) { o[date] = n; daily[date] = (daily[date] || 0) + n; }
    if (Object.keys(o).length) repoDaily[repo] = o;
  }
  const total = Object.values(daily).reduce((a, b) => a + b, 0);
  console.log(`  ${privateRepos.size} private repo(s) ${opts.includePrivate ? 'included' : 'excluded'}.`);

  const html = renderHTML({ login, daily, repoDaily, defaultGranularity: opts.granularity, style: opts.style, total, rangeStart, rangeEnd });
  const outFile = path.resolve(opts.output || 'commit-history.html');
  fs.writeFileSync(outFile, html);
  console.log(`\n${total.toLocaleString()} commits from ${rangeStart} to ${rangeEnd}. Wrote ${outFile}`);

  if (opts.open) openInBrowser(outFile);
}

main();
