#!/usr/bin/env node
/**
 * Civitai "best time to post" analyzer.
 *
 * Pulls the most-reacted images across Civitai, buckets them by the calendar
 * year / day-of-week / hour-of-day they were posted, and compares that against
 * a baseline of *all* uploads so we measure genuine advantage (lift) rather
 * than raw upload volume.
 *
 * Output: a single JSON file (default analysis/posting-analysis.json) consumed
 * by viewer.html.
 *
 * IMPORTANT — read analysis/README.md for methodology and caveats. Two that
 * matter most:
 *   1. The public API has no calendar-year or date-range filter, and `period`
 *      is a rolling window. So we deep-paginate `sort=Most Reactions` ONCE and
 *      bucket by createdAt year locally. Quiet years fill more slowly; raise
 *      MAX_PAGES to give them more coverage.
 *   2. A true per-year baseline is infeasible (millions of requests). We sample
 *      recent uploads for the day/hour rhythm and reuse it across years,
 *      assuming the *shape* of when people upload is roughly stable over time.
 *
 * Usage:
 *   node analyze-posting-times.js                 # live fetch + analyze
 *   node analyze-posting-times.js --sample        # write synthetic data, no network
 *   node analyze-posting-times.js --in raw.json   # re-analyze a saved raw dump
 *
 * Env knobs (all optional):
 *   CIVITAI_API_KEY     Bearer token (higher rate limits; not required)
 *   PER_YEAR            Top images to keep per calendar year (default 5000)
 *   MAX_PAGES           Max pages (×200) per nsfw level for the top pull (default 300)
 *   BASELINE_TARGET     Recent uploads to sample for the baseline (default 20000)
 *   NSFW_LEVELS         Comma list: None,Soft,Mature,X (default all four)
 *   PAGE_DELAY_MS       Delay between pages (default 500)
 *   OUT                 Output path (default ./posting-analysis.json)
 *   RAW_OUT             If set, also dump the raw collected images here
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CIVITAI_API_KEY = process.env.CIVITAI_API_KEY || '';
const PER_YEAR = intEnv('PER_YEAR', 5000);
// Pages (×200 imgs) per nsfw level. Kept modest on purpose: the most-reacted
// stream front-loads the busy years, so a few thousand per level is plenty to
// fill most year buckets, and going deeper mostly just hammers the API (which
// starts returning 503s). Raise it if quiet years come back "partial".
const MAX_PAGES = intEnv('MAX_PAGES', 60);
const BASELINE_TARGET = intEnv('BASELINE_TARGET', 20000);
const PAGE_DELAY_MS = intEnv('PAGE_DELAY_MS', 800);
const NSFW_LEVELS = (process.env.NSFW_LEVELS || 'None,Soft,Mature,X')
  .split(',').map(s => s.trim()).filter(Boolean);
const OUT = process.env.OUT || join(__dirname, 'posting-analysis.json');
// Slim raw dump of the collected data (just createdAt + reactions). Always
// written on a live fetch so you can recompute any view later with
// `--in posting-raw.json` — no second trip to the API.
const RAW_OUT = process.env.RAW_OUT || join(__dirname, 'posting-raw.json');

const API_BASE = 'https://civitai.com/api/v1';
const PAGE_LIMIT = 200;
const MAX_RETRIES = 6;

// ---------- small utils ----------
function intEnv(name, def) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Total "reactions" for an image. Matches the metric used by the existing
// collector (fetch-stats.js): likes + hearts + laughs + cries.
function totalReactions(stats = {}) {
  return (stats.likeCount || 0) + (stats.heartCount || 0) +
         (stats.laughCount || 0) + (stats.cryCount || 0);
}

async function fetchWithRetry(url, backoff = 1500) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers = {};
      if (CIVITAI_API_KEY) headers['Authorization'] = `Bearer ${CIVITAI_API_KEY}`;
      const res = await fetch(url, { headers });
      // 429 (rate limited) and 5xx (server overloaded, e.g. the 503s Civitai
      // throws under sustained load) are transient — wait and retry rather than
      // treat them as fatal.
      if (res.status === 429 || res.status >= 500) {
        if (attempt === MAX_RETRIES) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10);
        const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : backoff;
        console.log(`  server busy (HTTP ${res.status}), waiting ${wait}ms (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(wait); backoff *= 2; continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.log(`  attempt ${attempt} failed: ${err.message}; retry in ${backoff}ms`);
      await sleep(backoff); backoff *= 2;
    }
  }
}

/**
 * Cursor-paginate an images query, invoking onItems(items) per page.
 * Stops when: shouldStop() is true, no nextPage, or maxPages reached.
 */
async function paginate(startUrl, label, { maxPages, onItems, shouldStop }) {
  let next = startUrl, page = 0, total = 0;
  while (next && page < maxPages) {
    page++;
    const data = await fetchWithRetry(next);
    const items = data?.items || [];
    total += items.length;
    onItems(items);
    if (page % 10 === 0 || items.length === 0) {
      console.log(`  [${label}] page ${page}, ${total} items so far`);
    }
    if (shouldStop && shouldStop()) { console.log(`  [${label}] target reached, stopping at page ${page}`); break; }
    next = data?.metadata?.nextPage || null;
    if (next) await sleep(PAGE_DELAY_MS);
  }
  console.log(`  [${label}] done: ${page} pages, ${total} items`);
  return total;
}

// ---------- collection ----------
async function collectTopImages() {
  // id -> { createdAt, reactions, stats, nsfwLevel }
  const byId = new Map();
  for (const level of NSFW_LEVELS) {
    const nsfwParam = level === 'None' ? '' : `&nsfw=${encodeURIComponent(level)}`;
    const url = `${API_BASE}/images?limit=${PAGE_LIMIT}&sort=${encodeURIComponent('Most Reactions')}&period=AllTime${nsfwParam}`;
    console.log(`\nTop pull — nsfw=${level}`);
    // If the API gives up on this level (e.g. sustained 503s), keep everything
    // collected so far and move on — never throw the whole run's work away.
    try {
      await paginate(url, `top:${level}`, {
        maxPages: MAX_PAGES,
        onItems: items => {
          for (const it of items) {
            if (!it?.createdAt || byId.has(it.id)) continue;
            byId.set(it.id, {
              id: it.id,
              createdAt: it.createdAt,
              reactions: totalReactions(it.stats),
              stats: it.stats || {},
            });
          }
        },
      });
    } catch (err) {
      console.log(`  ⚠️  [top:${level}] stopped early (${err.message}); keeping ${byId.size} images collected so far and continuing.`);
    }
  }
  return Array.from(byId.values());
}

async function collectBaseline() {
  // Most-recent uploads, reaction-agnostic, for the day/hour rhythm.
  const byId = new Map();
  const perLevel = Math.ceil(BASELINE_TARGET / NSFW_LEVELS.length);
  for (const level of NSFW_LEVELS) {
    const nsfwParam = level === 'None' ? '' : `&nsfw=${encodeURIComponent(level)}`;
    const url = `${API_BASE}/images?limit=${PAGE_LIMIT}&sort=Newest&period=AllTime${nsfwParam}`;
    let kept = 0;
    console.log(`\nBaseline pull — nsfw=${level} (target ${perLevel})`);
    try {
      await paginate(url, `base:${level}`, {
        maxPages: Math.ceil(perLevel / PAGE_LIMIT) + 2,
        shouldStop: () => kept >= perLevel,
        onItems: items => {
          for (const it of items) {
            if (!it?.createdAt || byId.has(it.id)) continue;
            byId.set(it.id, { createdAt: it.createdAt });
            kept++;
          }
        },
      });
    } catch (err) {
      console.log(`  ⚠️  [base:${level}] stopped early (${err.message}); keeping ${byId.size} baseline rows and continuing.`);
    }
  }
  return Array.from(byId.values());
}

// ---------- analysis ----------
function emptyMatrix() {
  return Array.from({ length: 7 }, () => new Array(24).fill(0));
}

// Bucket a list of {createdAt} into a 7x24 [day][hour] matrix (UTC).
function bucketMatrix(rows) {
  const m = emptyMatrix();
  let counted = 0;
  for (const r of rows) {
    const d = new Date(r.createdAt);
    if (isNaN(d)) continue;
    m[d.getUTCDay()][d.getUTCHours()]++;
    counted++;
  }
  return { matrix: m, total: counted };
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

// Reaction-count buckets for the "distribution of how big the top images were"
// histogram. Last bucket is open-ended (10k+).
const HIST_EDGES = [0, 100, 250, 500, 1000, 2500, 5000, 10000, Infinity];
const HIST_LABELS = ['0–100', '100–250', '250–500', '500–1k', '1k–2.5k', '2.5k–5k', '5k–10k', '10k+'];
function histogram(reactionsAsc) {
  const h = new Array(HIST_LABELS.length).fill(0);
  for (const r of reactionsAsc) {
    for (let b = 0; b < HIST_LABELS.length; b++) {
      if (r >= HIST_EDGES[b] && r < HIST_EDGES[b + 1]) { h[b]++; break; }
    }
  }
  return h;
}

function analyze(topImages, baselineRows) {
  // Group top images by calendar year, keep top PER_YEAR by reactions.
  const byYear = new Map();
  for (const img of topImages) {
    const y = new Date(img.createdAt).getUTCFullYear();
    if (!Number.isFinite(y)) continue;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(img);
  }

  const years = {};
  for (const [year, imgs] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    imgs.sort((a, b) => b.reactions - a.reactions);
    const kept = imgs.slice(0, PER_YEAR);
    const { matrix, total } = bucketMatrix(kept);
    const reactionsAsc = kept.map(i => i.reactions).sort((a, b) => a - b);
    const sum = reactionsAsc.reduce((s, v) => s + v, 0);

    // Per-month breakdown (Jan..Dec): how many top images, and how strong they
    // were. No "lift" here (the recent baseline can't speak to old months), so
    // these are raw counts — the "data collected" view.
    const monthCount = new Array(12).fill(0);
    const monthReactions = Array.from({ length: 12 }, () => []);
    for (const img of kept) {
      const m = new Date(img.createdAt).getUTCMonth();
      monthCount[m]++;
      monthReactions[m].push(img.reactions);
    }
    const monthMedian = monthReactions.map(a => percentile(a.sort((x, y) => x - y), 50));

    years[year] = {
      count: kept.length,
      collected: imgs.length,            // how many of this year we actually saw
      capped: imgs.length > PER_YEAR,    // true => we hit the PER_YEAR cap (good coverage)
      matrix,
      counted: total,
      months: monthCount,
      monthMedian,
      histogram: histogram(reactionsAsc),
      reactions: {
        mean: kept.length ? Math.round(sum / kept.length) : 0,
        median: percentile(reactionsAsc, 50),
        p90: percentile(reactionsAsc, 90),
        max: reactionsAsc[reactionsAsc.length - 1] || 0,
      },
    };
  }

  const base = bucketMatrix(baselineRows);

  return {
    generatedAt: new Date().toISOString(),
    timezone: 'UTC',
    metric: 'likes+hearts+laughs+cries',
    config: { PER_YEAR, MAX_PAGES, BASELINE_TARGET, NSFW_LEVELS },
    histLabels: HIST_LABELS,
    baseline: { matrix: base.matrix, total: base.total },
    years,
  };
}

// ---------- synthetic sample (no network) ----------
function syntheticData() {
  // Build believable-looking data so the viewer is demonstrable offline.
  // Upload rhythm: peaks evenings UTC, weekends slightly higher. Top images
  // get an injected "advantage" in a couple of weekday-evening cells so lift
  // shows a real pattern rather than flat noise.
  const rand = mulberry32(42);
  const baseWeight = (day, hour) => {
    const evening = Math.exp(-((hour - 19) ** 2) / 40) + 0.4 * Math.exp(-((hour - 3) ** 2) / 30);
    const weekend = (day === 0 || day === 6) ? 1.25 : 1.0;
    return evening * weekend + 0.05;
  };
  const advantage = (day, hour) => {
    // Tue–Thu around 14:00–17:00 UTC over-performs.
    const good = (day >= 2 && day <= 4) && hour >= 14 && hour <= 17;
    return good ? 1.8 : 1.0;
  };
  const sampleCell = weightFn => {
    // pick a (day,hour) proportional to weight
    const cells = [];
    let acc = 0;
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      acc += weightFn(d, h); cells.push([d, h, acc]);
    }
    const x = rand() * acc;
    for (const [d, h, c] of cells) if (x <= c) return [d, h];
    return [6, 23];
  };

  // Last month with data per year: 2026 is "the current, partial year" (data
  // only through ~June), everyone else is a full year.
  const lastMonth = y => (y === 2026 ? 5 : 11);
  // Pick a month with a gentle per-year seasonal wobble so the month charts
  // aren't flat in the demo.
  const pickMonth = y => {
    const maxM = lastMonth(y);
    const cum = []; let acc = 0;
    for (let m = 0; m <= maxM; m++) {
      acc += Math.max(0.15, 1 + 0.6 * Math.sin((m / 12) * Math.PI * 2 + (y % 3)));
      cum.push(acc);
    }
    const x = rand() * acc;
    for (let m = 0; m < cum.length; m++) if (x <= cum[m]) return m;
    return maxM;
  };

  const baselineRows = [];
  for (let i = 0; i < 20000; i++) {
    const [d, h] = sampleCell(baseWeight);
    baselineRows.push({ createdAt: synthDate(2025, Math.floor(rand() * 12), d, h, rand) });
  }

  const topImages = [];
  const years = [2022, 2023, 2024, 2025, 2026];
  // Year "health": boom 2023-24, decline after — drives median reactions.
  const yearScale = { 2022: 0.6, 2023: 1.0, 2024: 1.3, 2025: 0.7, 2026: 0.4 };
  // Generated volume: boom years overshoot the per-year cap (coverage "full"),
  // the first/last years fall short of it ("partial") to exercise the flag.
  const yearVolume = { 2022: 0.8, 2023: 1.5, 2024: 2.0, 2025: 1.2, 2026: 0.5 };
  for (const y of years) {
    const n = Math.round(PER_YEAR * yearVolume[y]);
    for (let i = 0; i < n; i++) {
      const [d, h] = sampleCell((dd, hh) => baseWeight(dd, hh) * advantage(dd, hh));
      const reactions = Math.round((200 + rand() * 4000) * yearScale[y]);
      topImages.push({ id: `${y}-${i}`, createdAt: synthDate(y, pickMonth(y), d, h, rand), reactions, stats: {} });
    }
  }
  return { topImages, baselineRows };
}
// Build an ISO date in the given year+month whose UTC weekday is `day`, at `hour`.
function synthDate(year, month, day, hour, rand) {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const matching = [];
  for (let dd = 1; dd <= daysInMonth; dd++) {
    if (new Date(Date.UTC(year, month, dd)).getUTCDay() === day) matching.push(dd);
  }
  const dd = matching.length ? matching[Math.floor(rand() * matching.length)]
                             : 1 + Math.floor(rand() * daysInMonth);
  return new Date(Date.UTC(year, month, dd, hour, Math.floor(rand() * 60))).toISOString();
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const sample = args.includes('--sample');
  const inIdx = args.indexOf('--in');
  const inFile = inIdx >= 0 ? args[inIdx + 1] : null;

  let topImages, baselineRows;

  if (sample) {
    console.log('Generating synthetic sample data (no network)…');
    ({ topImages, baselineRows } = syntheticData());
  } else if (inFile) {
    console.log(`Re-analyzing raw dump: ${inFile}`);
    const raw = JSON.parse(readFileSync(inFile, 'utf8'));
    topImages = raw.topImages; baselineRows = raw.baselineRows;
  } else {
    console.log('Live fetch from civitai.com (this can take a while)…');
    if (!CIVITAI_API_KEY) console.log('No CIVITAI_API_KEY set — using unauthenticated requests.');
    topImages = await collectTopImages();
    baselineRows = await collectBaseline();
    console.log(`\nCollected ${topImages.length} unique top images, ${baselineRows.length} baseline rows.`);
    if (RAW_OUT) {
      // Slim it down: all any view needs is when + how popular.
      const slim = {
        topImages: topImages.map(i => ({ createdAt: i.createdAt, reactions: i.reactions })),
        baselineRows: baselineRows.map(b => ({ createdAt: b.createdAt })),
      };
      writeFileSync(RAW_OUT, JSON.stringify(slim));
      console.log(`Raw data saved to ${RAW_OUT} (recompute views later with: node analyze-posting-times.js --in posting-raw.json)`);
    }
  }

  const result = analyze(topImages, baselineRows);
  writeFileSync(OUT, JSON.stringify(result, null, 2));

  console.log('\n=== Summary ===');
  for (const [y, info] of Object.entries(result.years)) {
    const flag = info.capped ? '' : '  (under cap — raise MAX_PAGES for fuller coverage)';
    console.log(`  ${y}: ${info.count} imgs, median reactions ${info.reactions.median}${flag}`);
  }
  console.log(`\nWrote ${OUT}`);
  console.log('Open analysis/viewer.html and load that file to explore.');
}

main().catch(err => { console.error(err); process.exit(1); });
