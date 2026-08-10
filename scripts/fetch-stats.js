import { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Shared snapshot codec — same file the extension loads (single source of truth
// for the delta format). Lives under extension/lib/ because Chrome cannot load
// files from outside the extension root.
import SnapshotCodec from '../extension/lib/snapshot-codec.js';
import { createTrpcHeaders, extractTrpcPayload } from './lib/trpc.js';
import { aggregateSnapshots, applyRetentionPolicy } from './lib/retention.js';
import {
  assertSafeTransition,
  CURRENT_FORMAT_VERSION,
  inspectStatsData
} from './lib/stats-validation.js';

const {
  isDelta,
  resolveAt: resolveSnapshot,
  resolveAll: resolveAllSnapshots,
  encodeAsDeltas
} = SnapshotCodec;

// Environment variables
const GIST_ID = process.env.GIST_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;
const CIVITAI_USERNAME = process.env.CIVITAI_USERNAME;
const CIVITAI_API_KEY = process.env.CIVITAI_API_KEY; // Optional - may help get accurate stats
// R-and-harder content was moved to a separate domain (civitai.red). The .red
// API uses the same backend/shape; fall back to the .com key if none is set.
const CIVITAI_RED_API_KEY = process.env.CIVITAI_RED_API_KEY || process.env.CIVITAI_API_KEY;
const CIVITAI_RED_ENABLED = (process.env.CIVITAI_RED_ENABLED || 'true').toLowerCase() !== 'false';
const REFRESH_TIER_OVERRIDE = process.env.REFRESH_TIER; // Optional: 'auto', 'daily', 'monthly', 'quarterly'
const DRY_RUN = (process.env.DRY_RUN || '').toLowerCase() === 'true';
const SAFETY_EXPORT_DIR = process.env.SAFETY_EXPORT_DIR || '';
// Escape hatch for the never-decrease clamp: images listed here (comma-separated
// IDs) take the API's fresh values as-is for this run, so an inflated stat that
// got baked in by the clamp can be corrected. See README "Fixing inflated stats".
const RESET_IMAGE_IDS = new Set(
  (process.env.RESET_IMAGE_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
// Force a full discovery sweep (all pages, all NSFW levels, both hosts) on a
// daily-tier run. Monthly/quarterly tiers and first runs always sweep fully.
const FULL_DISCOVERY = (process.env.FULL_DISCOVERY || '').toLowerCase() === 'true';
// How many post titles to resolve per run. Titles are used to give images a
// human name in the extension; unresolved posts are retried on later runs, so
// the initial backfill drains over a few runs instead of blowing one up.
const POST_TITLE_BUDGET = parseBoundedNumber(process.env.POST_TITLE_BUDGET, 300, 0, 10000);
const REQUEST_TIMEOUT_MS = parseBoundedNumber(process.env.REQUEST_TIMEOUT_MS, 30000, 1000, 120000);
const MAX_REFRESH_FAILURE_RATIO = parseBoundedNumber(
  process.env.MAX_REFRESH_FAILURE_RATIO, 0.25, 0, 1
);

let octokit = null;

// Constants
const CIVITAI_API_BASE = 'https://civitai.com/api/v1';
const CIVITAI_RED_API_BASE = 'https://civitai.red/api/v1';
const IMAGES_PER_PAGE = 200;

// Map an image's host ('com' | 'red') to its API base and site origin.
function apiBaseForHost(host) {
  return host === 'red' ? CIVITAI_RED_API_BASE : CIVITAI_API_BASE;
}
function siteOriginForHost(host) {
  return host === 'red' ? 'https://civitai.red' : 'https://civitai.com';
}
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const STATS_FETCH_DELAY_MS = 300; // Delay between individual image stats fetches
const STATS_BATCH_SIZE = 5; // Number of concurrent stats fetches

function parseBoundedNumber(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid numeric configuration "${value}"; expected ${min}..${max}`);
  }
  return parsed;
}

function validateRuntimeConfig() {
  const missing = [];
  if (!GIST_ID) missing.push('GIST_ID');
  if (!GIST_TOKEN) missing.push('GIST_TOKEN');
  if (!CIVITAI_USERNAME) missing.push('CIVITAI_USERNAME');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function logRuntimeConfig() {
  console.log(CIVITAI_API_KEY
    ? 'Using Civitai API key for authenticated requests'
    : 'No CIVITAI_API_KEY set - tRPC is skipped and core counters use REST fallback');
  console.log(CIVITAI_RED_ENABLED
    ? `civitai.red capture: enabled${process.env.CIVITAI_RED_API_KEY ? ' (dedicated key)' : ' (using .com key)'}`
    : 'civitai.red capture: disabled');
  if (RESET_IMAGE_IDS.size > 0) {
    console.log(`Clamp reset requested for ${RESET_IMAGE_IDS.size} image(s): ${[...RESET_IMAGE_IDS].join(', ')}`);
  }
  if (DRY_RUN) console.log('DRY RUN: the collector will validate and export data but will not update the Gist');
}

/**
 * Fetch with exponential backoff retry
 */
function retryAfterDelayMs(value, fallback) {
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateDelay = Date.parse(value) - Date.now();
  return Number.isFinite(dateDelay) ? Math.max(0, dateDelay) : fallback;
}

async function fetchWithRetry(
  url,
  retries = MAX_RETRIES,
  backoff = INITIAL_BACKOFF_MS,
  extraHeaders = {}
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const headers = {};
      // Pick the auth key by host so .red requests use the .red key (which may
      // differ from the .com key, though it falls back to it).
      const key = url.includes('civitai.red') ? CIVITAI_RED_API_KEY : CIVITAI_API_KEY;
      if (key) {
        headers['Authorization'] = `Bearer ${key}`;
      }
      Object.assign(headers, extraHeaders);
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (response.status === 429) {
        // Rate limited - wait and retry
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfterDelayMs(retryAfter, backoff);
        console.log(`Rate limited. Waiting ${waitTime}ms before retry ${attempt}/${retries}`);
        await sleep(waitTime);
        backoff *= 2;
        continue;
      }

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.status = response.status;
        error.retryable = response.status === 408 || response.status >= 500;
        throw error;
      }

      return await response.json();
    } catch (error) {
      if (attempt === retries || error.retryable === false) {
        throw error;
      }
      console.log(`Attempt ${attempt} failed: ${error.message}. Retrying in ${backoff}ms...`);
      await sleep(backoff);
      backoff *= 2;
    }
  }
  // Only reachable when every attempt hit a 429 (the catch path rethrows on the
  // last attempt). Fail loudly instead of returning undefined.
  throw new Error(`Rate limited after ${retries} retries: ${url}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch stats for a single image. Authenticated tRPC is preferred because it
 * includes buzz/collects/views; REST is a safe fallback for the core counters.
 */
async function fetchImageStatsViaTrpc(imageId, host) {
  const input = { json: { id: Number(imageId) } };
  const url = `${siteOriginForHost(host)}/api/trpc/image.get?input=${encodeURIComponent(JSON.stringify(input))}`;
  const key = host === 'red' ? CIVITAI_RED_API_KEY : CIVITAI_API_KEY;
  const data = await fetchWithRetry(
    url, MAX_RETRIES, INITIAL_BACKOFF_MS, createTrpcHeaders(siteOriginForHost(host), key)
  );
  const item = extractTrpcPayload(data);
  if (!item?.stats) throw new Error('unexpected tRPC image.get response shape');
  const s = item.stats;
  return {
    likeCount: s.likeCountAllTime || 0,
    heartCount: s.heartCountAllTime || 0,
    laughCount: s.laughCountAllTime || 0,
    cryCount: s.cryCountAllTime || 0,
    commentCount: s.commentCountAllTime || 0,
    buzzCount: s.tippedAmountCountAllTime || 0,
    collectCount: s.collectedCountAllTime || 0,
    viewCount: s.viewCountAllTime || 0,
    _source: 'trpc',
    _host: host
  };
}

async function fetchImageStatsViaRest(imageId, host) {
  const url = `${apiBaseForHost(host)}/images?imageId=${encodeURIComponent(imageId)}`;
  const data = await fetchWithRetry(url);
  const item = data?.items?.[0];
  if (!item?.stats) throw new Error('unexpected REST image response shape');
  return {
    likeCount: item.stats.likeCount || 0,
    heartCount: item.stats.heartCount || 0,
    laughCount: item.stats.laughCount || 0,
    cryCount: item.stats.cryCount || 0,
    commentCount: item.stats.commentCount || 0,
    _source: 'rest',
    _host: host
  };
}

async function fetchImageStats(imageId, host = 'com') {
  const key = host === 'red' ? CIVITAI_RED_API_KEY : CIVITAI_API_KEY;
  const failures = [];

  if (key) {
    try {
      return await fetchImageStatsViaTrpc(imageId, host);
    } catch (error) {
      failures.push(`tRPC ${host}: ${error.message}`);
    }
  }

  const restHosts = [host];
  if (CIVITAI_RED_ENABLED) restHosts.push(host === 'red' ? 'com' : 'red');
  for (let i = 0; i < restHosts.length; i++) {
    const restHost = restHosts[i];
    try {
      return await fetchImageStatsViaRest(imageId, restHost);
    } catch (error) {
      failures.push(`REST ${restHost}: ${error.message}`);
      // Only a 404 suggests the record may have moved to the other host.
      if (error.status !== 404) break;
    }
  }

  console.log(`  Warning: Failed to fetch stats for image ${imageId}: ${failures.join('; ')}`);
  return null;
}

/**
 * Extract the public follower total from user.getCreator without treating a
 * missing/changed response shape as zero. A zero returned by Civitai is valid;
 * an absent value is a collection failure and must leave history untouched.
 */
function extractCreatorFollowers(creator) {
  const followers = creator?.stats?.followerCountAllTime;
  if (!Number.isFinite(followers) || followers < 0 || !Number.isInteger(followers)) {
    throw new Error('unexpected user.getCreator follower response shape');
  }
  return followers;
}

async function fetchCreatorFollowers(username) {
  const input = { json: { username } };
  const origin = siteOriginForHost('com');
  const url = `${origin}/api/trpc/user.getCreator?input=${encodeURIComponent(JSON.stringify(input))}`;
  const data = await fetchWithRetry(
    url, MAX_RETRIES, INITIAL_BACKOFF_MS, createTrpcHeaders(origin, CIVITAI_API_KEY)
  );
  return extractCreatorFollowers(extractTrpcPayload(data));
}

function appendCreatorSnapshot(existingSnapshots, timestamp, followers, retentionReferenceTime) {
  if (!validCreatorFollowerCount(followers)) {
    throw new Error(`Invalid follower count: ${String(followers)}`);
  }
  const snapshots = [...(existingSnapshots || []), { timestamp, followers }];
  const retained = applyRetentionPolicy(snapshots, retentionReferenceTime);
  return {
    snapshots: retained,
    retentionRemoved: snapshots.length - retained.length
  };
}

function validCreatorFollowerCount(value) {
  return Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

/**
 * Post titles — the source of human-readable image names in the extension.
 *
 * Two ways in, cheapest first:
 *   1. tRPC `post.get`, which needs a Civitai API key. A few hundred bytes.
 *   2. Scraping the post page's embedded Next.js payload. ~110KB per post, so
 *      only used when tRPC is unavailable (it 401s for unauthenticated callers).
 *
 * Availability is cached per host. A definitive auth/shape failure costs one
 * probe; transient failures fall back for that post without disabling tRPC for
 * the rest of the run.
 */
const trpcPostGetAvailability = new Map();

async function fetchPostTitleViaTrpc(postId, host) {
  const input = { json: { id: Number(postId) } };
  const url = `${siteOriginForHost(host)}/api/trpc/post.get?input=${encodeURIComponent(JSON.stringify(input))}`;
  const key = host === 'red' ? CIVITAI_RED_API_KEY : CIVITAI_API_KEY;
  if (!key) throw new Error('no API key available for tRPC post.get');
  const data = await fetchWithRetry(
    url, MAX_RETRIES, INITIAL_BACKOFF_MS, createTrpcHeaders(siteOriginForHost(host), key)
  );
  const post = extractTrpcPayload(data);
  if (!post) throw new Error('unexpected tRPC response shape');
  // A post with no title yields null — a valid, cacheable answer, not a failure.
  return typeof post.title === 'string' && post.title.trim() ? post.title.trim() : null;
}

/**
 * Pull the title out of a post page's __NEXT_DATA__ blob.
 *
 * Match the cached query by `state.data.id`, NOT by array index: index 0 has
 * been observed to be the site-wide announcement banner, whose title would
 * otherwise be silently adopted as the post's name.
 */
function extractPostTitleFromHtml(html, postId) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return { ok: false, reason: 'no __NEXT_DATA__' };

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { ok: false, reason: 'unparseable __NEXT_DATA__' };
  }

  const queries = parsed?.props?.pageProps?.trpcState?.json?.queries || [];
  for (const query of queries) {
    const data = query?.state?.data;
    if (data && Number(data.id) === Number(postId)) {
      const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
      return { ok: true, title };
    }
  }
  return { ok: false, reason: 'no query matched the post id' };
}

async function fetchPostTitleViaHtml(postId, host) {
  const response = await fetch(`${siteOriginForHost(host)}/posts/${postId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; civitai-reaction-stats)' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = extractPostTitleFromHtml(await response.text(), postId);
  if (!result.ok) throw new Error(result.reason);
  return result.title;
}

/**
 * Resolve one post's title. Returns { title } on success (title may be null for
 * an untitled post) or null when the post could not be read at all — the caller
 * distinguishes the two so "untitled" gets cached and "failed" gets retried.
 */
async function fetchPostTitle(postId, host = 'com') {
  const key = host === 'red' ? CIVITAI_RED_API_KEY : CIVITAI_API_KEY;
  const availability = trpcPostGetAvailability.get(host);
  if (key && availability !== false) {
    try {
      const title = await fetchPostTitleViaTrpc(postId, host);
      if (availability == null) {
        trpcPostGetAvailability.set(host, true);
        console.log(`  Post titles (${host}): using tRPC post.get`);
      }
      return { title };
    } catch (error) {
      const definitive = [401, 403, 404].includes(error.status) ||
        error.message.includes('unexpected tRPC');
      if (definitive) {
        trpcPostGetAvailability.set(host, false);
        console.log(`  Post titles (${host}): tRPC unavailable (${error.message}) — using page scraping`);
      } else {
        console.log(`  Post titles (${host}): transient tRPC failure (${error.message}) — scraping this post`);
      }
      // fall through to the HTML path
    }
  }

  try {
    return { title: await fetchPostTitleViaHtml(postId, host) };
  } catch (error) {
    console.log(`  Warning: could not read title for post ${postId}: ${error.message}`);
    return null;
  }
}

/**
 * Resolve titles for posts we don't have yet, newest images first, up to a
 * per-run budget. Existing entries are kept; re-checks happen on escalated
 * tiers only, since titles rarely change.
 */
async function refreshPostTitles(images, existingPostTitles, tier) {
  const postTitles = { ...(existingPostTitles || {}) };

  // One representative host per post, newest first — a post's images share a host.
  const seen = new Map();
  const ordered = [...images].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  for (const img of ordered) {
    if (img.postId == null) continue;
    const key = String(img.postId);
    if (!seen.has(key)) seen.set(key, img.host || 'com');
  }

  // Posts we've never resolved always come first. On an escalated tier we also
  // re-check known ones, but only with whatever budget is left over — otherwise
  // a re-check sweep spends the entire budget re-reading titles we already have
  // while images with no name at all keep waiting.
  const unresolved = [];
  const resolved = [];
  for (const entry of seen.entries()) {
    (entry[0] in postTitles ? resolved : unresolved).push(entry);
  }

  const recheck = tier === 'monthly' || tier === 'quarterly';
  const pending = recheck ? [...unresolved, ...resolved] : unresolved;

  if (pending.length === 0) {
    console.log(`\nPost titles: ${Object.keys(postTitles).length} known, nothing new to resolve`);
    return postTitles;
  }

  const budgeted = pending.slice(0, POST_TITLE_BUDGET);
  const newInBatch = budgeted.filter(([postId]) => !(postId in postTitles)).length;
  console.log(`\nResolving post titles: ${budgeted.length} of ${pending.length} pending ` +
    `(${newInBatch} never seen, ${budgeted.length - newInBatch} re-checks; budget ${POST_TITLE_BUDGET}, tier: ${tier})`);

  let titled = 0;
  let untitled = 0;
  let failed = 0;

  for (let i = 0; i < budgeted.length; i++) {
    const [postId, host] = budgeted[i];
    const result = await fetchPostTitle(postId, host);

    if (result) {
      postTitles[postId] = { title: result.title, fetchedAt: new Date().toISOString() };
      if (result.title) titled++;
      else untitled++;
    } else {
      failed++; // left absent so a later run retries it
    }

    // Page scraping is ~110KB a pop; pace it. tRPC is cheap enough to go faster.
    if (i < budgeted.length - 1) {
      await sleep(trpcPostGetAvailability.get(host) === true ? 150 : 500);
    }
  }

  const remaining = pending.length - budgeted.length;
  console.log(`Post titles: ${titled} titled, ${untitled} untitled, ${failed} failed` +
    (remaining > 0 ? ` — ${remaining} left for the next run` : ''));

  return postTitles;
}

/**
 * Determine which tier of refresh to run based on current date or override
 * - Daily: images from last 30 days + any with 0 stats
 * - Monthly (1st of month): also images from 1-6 months ago
 * - Quarterly (1st of month in Jan/Apr/Jul/Oct): ALL images
 */
function determineRefreshTier(now = new Date(), override = null) {
  if (override && override !== 'auto') {
    if (!['daily', 'monthly', 'quarterly'].includes(override)) {
      throw new Error(`Invalid refresh tier override: ${override}`);
    }
    return override;
  }

  // Auto: determine tier based on date (UTC — matches the Actions cron).
  // Escalated tiers fire only at hour 0: the job runs hourly and would
  // otherwise repeat the expensive full refresh 24 times on tier days.
  const dayOfMonth = now.getUTCDate();
  const month = now.getUTCMonth(); // 0-indexed
  const hour = now.getUTCHours();

  if (dayOfMonth === 1 && hour === 0 && month % 3 === 0) {
    return 'quarterly';
  }
  if (dayOfMonth === 1 && hour === 0) {
    return 'monthly';
  }
  return 'daily';
}

function getRefreshTier() {
  const tier = determineRefreshTier(new Date(), REFRESH_TIER_OVERRIDE);
  if (REFRESH_TIER_OVERRIDE && REFRESH_TIER_OVERRIDE !== 'auto') {
    console.log(`Using manual refresh tier override: ${tier}`);
  }
  return tier;
}

/**
 * Refresh image stats individually based on a tiered schedule.
 * The Civitai bulk API returns stale stats, so we re-fetch individually
 * on a smart schedule to keep stats fresh without excessive API calls.
 */
async function refreshImageStats(images, tier) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const sixMonthsAgo = new Date(now - 180 * 24 * 60 * 60 * 1000);

  // Determine which images to refresh
  const toRefresh = new Set();

  for (const img of images) {
    const total = (img.stats?.likeCount || 0) + (img.stats?.heartCount || 0) +
                  (img.stats?.laughCount || 0) + (img.stats?.cryCount || 0);
    const createdAt = new Date(img.createdAt);

    // Always: images from the last 30 days
    if (createdAt >= thirtyDaysAgo) {
      toRefresh.add(img);
      continue;
    }

    // Zero-stat images older than 30 days: refresh on the monthly tier only.
    // (They used to be re-fetched every single hour forever, even when long dead.)
    if (total === 0) {
      if (tier === 'monthly' || tier === 'quarterly') {
        toRefresh.add(img);
      }
      continue;
    }

    // Monthly: also images from 1-6 months ago
    if ((tier === 'monthly' || tier === 'quarterly') && createdAt >= sixMonthsAgo) {
      toRefresh.add(img);
      continue;
    }

    // Quarterly: ALL images
    if (tier === 'quarterly') {
      toRefresh.add(img);
    }
  }

  const refreshList = [...toRefresh];

  console.log(`\nRefreshing stats: ${refreshList.length}/${images.length} images (tier: ${tier})`);
  console.log(`(Civitai API only returns accurate stats when querying by imageId)`);

  if (refreshList.length === 0) {
    return images;
  }

  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  let trpcSuccesses = 0;
  let restFallbacks = 0;

  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < refreshList.length; i += STATS_BATCH_SIZE) {
    const batch = refreshList.slice(i, i + STATS_BATCH_SIZE);

    const results = await Promise.all(
      batch.map(img => fetchImageStats(img.id, img.host || 'com'))
    );

    for (let j = 0; j < batch.length; j++) {
      const stats = results[j];
      if (stats) {
        const resetRequested = RESET_IMAGE_IDS.has(String(batch[j].id));
        if (resetRequested && stats._source !== 'trpc') {
          throw new Error(
            `Clamp reset for image ${batch[j].id} requires a complete tRPC response; ` +
            `refusing partial ${stats._source || 'unknown'} data`
          );
        }
        if (stats._source === 'trpc') trpcSuccesses++;
        if (stats._source === 'rest') restFallbacks++;
        if (stats._host) batch[j].host = stats._host;
        const cleanStats = { ...stats };
        delete cleanStats._source;
        delete cleanStats._host;
        const bulkStats = batch[j].stats || {};
        // Keep the higher value for each field — individual refresh should
        // correct understated bulk stats, not overwrite with stale/lower values.
        // Exception: a requested clamp reset trusts the fresh fetch as-is.
        const mergedStats = resetRequested ? cleanStats : {
          likeCount: Math.max(cleanStats.likeCount || 0, bulkStats.likeCount || 0),
          heartCount: Math.max(cleanStats.heartCount || 0, bulkStats.heartCount || 0),
          laughCount: Math.max(cleanStats.laughCount || 0, bulkStats.laughCount || 0),
          cryCount: Math.max(cleanStats.cryCount || 0, bulkStats.cryCount || 0),
          commentCount: Math.max(cleanStats.commentCount || 0, bulkStats.commentCount || 0),
          buzzCount: Math.max(cleanStats.buzzCount || 0, bulkStats.buzzCount || 0),
          collectCount: Math.max(cleanStats.collectCount || 0, bulkStats.collectCount || 0),
          viewCount: Math.max(cleanStats.viewCount || 0, bulkStats.viewCount || 0),
        };
        const oldTotal = (bulkStats.likeCount || 0) + (bulkStats.heartCount || 0) +
                         (bulkStats.laughCount || 0) + (bulkStats.cryCount || 0);
        const newTotal = (mergedStats.likeCount || 0) + (mergedStats.heartCount || 0) +
                         (mergedStats.laughCount || 0) + (mergedStats.cryCount || 0);
        batch[j].stats = mergedStats;
        // A successful individual refresh counts as "seen this run", even if
        // bulk discovery skipped this image (incremental mode).
        if (batch[j]._synthesized) {
          delete batch[j]._synthesized;
        }
        if (newTotal !== oldTotal) {
          updated++;
        } else {
          unchanged++;
        }
      } else {
        failed++;
        unchanged++;
      }
    }

    // Progress update every 50 images
    const processed = Math.min(i + STATS_BATCH_SIZE, refreshList.length);
    if (processed % 50 === 0 || processed === refreshList.length) {
      console.log(`  Progress: ${processed}/${refreshList.length} (${updated} changed)`);
    }

    // Delay between batches
    if (i + STATS_BATCH_SIZE < refreshList.length) {
      await sleep(STATS_FETCH_DELAY_MS);
    }
  }

  console.log(`\nIndividual stats refresh complete:`);
  console.log(`  Stats changed: ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Sources: ${trpcSuccesses} tRPC, ${restFallbacks} REST fallback, ${failed} failed`);

  // A few deleted/migrating images are normal. A broad tRPC fallback or fetch
  // failure is not: extended counters would silently freeze while the workflow
  // still looked green. Abort before building or writing a candidate dataset.
  const degraded = failed + (CIVITAI_API_KEY ? restFallbacks : 0);
  const degradedRatio = degraded / refreshList.length;
  if (refreshList.length >= 10 && degradedRatio > MAX_REFRESH_FAILURE_RATIO) {
    throw new Error(
      `Individual refresh health check failed: ${degraded}/${refreshList.length} ` +
      `(${(degradedRatio * 100).toFixed(1)}%) failed or fell back; limit is ` +
      `${(MAX_REFRESH_FAILURE_RATIO * 100).toFixed(1)}%`
    );
  }

  return images;
}

/**
 * Fetch all pages from a paginated API URL
 */
async function fetchAllPages(startUrl, label, stopAtKnownIds = null) {
  const allItems = [];
  let nextPage = startUrl;
  let pageCount = 0;

  while (nextPage) {
    pageCount++;
    console.log(`  [${label}] Fetching page ${pageCount}...`);

    const data = await fetchWithRetry(nextPage);

    if (data.items && data.items.length > 0) {
      allItems.push(...data.items);
      console.log(`    Retrieved ${data.items.length} images (total: ${allItems.length})`);

      // Incremental discovery: results are sorted Newest-first, so once an
      // entire page is already-known images, all later pages are known too.
      if (stopAtKnownIds && data.items.every(item => stopAtKnownIds.has(String(item.id)))) {
        console.log(`    [${label}] Page ${pageCount} contains only known images — stopping early`);
        break;
      }
    }

    nextPage = data.metadata?.nextPage || null;

    // Small delay between pages to be respectful
    if (nextPage) {
      await sleep(500);
    }
  }

  return allItems;
}

/**
 * Fetch all images for a user, paginating through all results.
 * Fetches each NSFW level separately because the API doesn't reliably return all in one call.
 * nsfw=true only returns Mature+X, omitting Soft (PG-13). See: github.com/civitai/civitai/issues/1795
 */
function totalReactionsOf(img) {
  return (img.stats?.likeCount || 0) + (img.stats?.heartCount || 0) +
         (img.stats?.laughCount || 0) + (img.stats?.cryCount || 0);
}

/**
 * Merge two discovery records for the same image id (rare post-split, since an
 * image lives on one host). Keep the per-field maximum and prefer the host whose
 * response reported the higher total.
 */
function mergeDiscoveredImage(a, b) {
  const base = totalReactionsOf(b) > totalReactionsOf(a) ? b : a;
  const fields = ['likeCount', 'heartCount', 'laughCount', 'cryCount',
    'commentCount', 'buzzCount', 'collectCount', 'viewCount'];
  const stats = {};
  for (const f of fields) {
    stats[f] = Math.max(a.stats?.[f] || 0, b.stats?.[f] || 0);
  }
  return { ...base, stats };
}

/**
 * Fetch all of a user's images from a single host, paginating each NSFW level.
 * Tags each returned image with its host ('com' | 'red').
 */
async function fetchUserImagesFromHost(username, host, stopAtKnownIds = null) {
  const baseUrl = `${apiBaseForHost(host)}/images?username=${encodeURIComponent(username)}&limit=${IMAGES_PER_PAGE}&sort=Newest&period=AllTime`;

  const nsfwLevels = [
    { param: '',             label: 'SFW (None)' },
    { param: '&nsfw=Soft',   label: 'Soft (PG-13)' },
    { param: '&nsfw=Mature', label: 'Mature (R)' },
    { param: '&nsfw=X',     label: 'X' },
  ];

  const results = [];
  for (const { param, label } of nsfwLevels) {
    const images = await fetchAllPages(`${baseUrl}${param}`, `${host}:${label}`, stopAtKnownIds);
    results.push({ label, count: images.length, images });
  }

  // Deduplicate within this host and tag the host on each image.
  const imageMap = new Map();
  for (const { images } of results) {
    for (const img of images) {
      img.host = host;
      imageMap.set(img.id, img);
    }
  }

  const breakdown = results.map(r => `${r.count} ${r.label}`).join(' + ');
  console.log(`[${host}] ${breakdown} = ${imageMap.size} unique images`);
  return Array.from(imageMap.values());
}

async function fetchAllUserImages(username, existingImages = []) {
  console.log(`Fetching images for user: ${username}`);

  // Incremental discovery: plain hourly (daily-tier) runs only need to find
  // NEW image IDs — each paginated stream stops at the first page made
  // entirely of known images. Known images that pagination doesn't reach are
  // synthesized from stored data below; their stat freshness comes from the
  // tiered per-image refresh, not from discovery. Full sweeps (monthly and
  // quarterly tiers, first run, or FULL_DISCOVERY=true) paginate everything
  // and are the only runs that can mark images stale.
  const tier = getRefreshTier();
  const fullSweep = tier !== 'daily' || FULL_DISCOVERY || existingImages.length === 0;
  const knownIds = fullSweep ? null : new Set(existingImages.map(img => String(img.id)));
  console.log(`Discovery mode: ${fullSweep ? 'full sweep' : `incremental (${knownIds.size} known images)`}`);

  // .com discovery is required.
  const comImages = await fetchUserImagesFromHost(username, 'com', knownIds);

  // .red discovery (R-and-harder content moved here). Best-effort: a failure
  // must not abort the whole run, otherwise a .red outage would lose .com data.
  let redImages = [];
  if (CIVITAI_RED_ENABLED) {
    try {
      redImages = await fetchUserImagesFromHost(username, 'red', knownIds);
    } catch (err) {
      console.log(`\n⚠️  civitai.red discovery failed (continuing with .com only): ${err.message}`);
    }
  } else {
    console.log('civitai.red discovery disabled (CIVITAI_RED_ENABLED=false)');
  }

  // Merge and deduplicate by image ID across both hosts.
  const imageMap = new Map();
  for (const img of [...comImages, ...redImages]) {
    const existing = imageMap.get(img.id);
    imageMap.set(img.id, existing ? mergeDiscoveredImage(existing, img) : img);
  }

  // Synthesize known images that incremental discovery didn't reach, so they
  // keep flowing into totals and are not misclassified as missing/stale.
  if (!fullSweep) {
    let synthesized = 0;
    for (const existing of existingImages) {
      if (imageMap.has(Number(existing.id)) || imageMap.has(existing.id)) continue;
      if (!existing.snapshots || existing.snapshots.length === 0) continue;
      const last = resolveSnapshot(existing.snapshots, existing.snapshots.length - 1);
      imageMap.set(existing.id, {
        id: existing.id,
        createdAt: existing.createdAt,
        url: existing.thumbnailUrl, // API field img.url = image file (becomes thumbnailUrl)
        meta: { prompt: existing.name },
        host: existing.host || 'com',
        postId: existing.postId ?? null,
        baseModel: existing.baseModel ?? null,
        stats: {
          likeCount: last.likes,
          heartCount: last.hearts,
          laughCount: last.laughs,
          cryCount: last.cries,
          commentCount: last.comments,
          buzzCount: last.buzz,
          collectCount: last.collects,
          viewCount: last.views
        },
        _synthesized: true
      });
      synthesized++;
    }
    if (synthesized > 0) {
      console.log(`Synthesized ${synthesized} known images not reached by incremental discovery`);
    }
  }

  const allImages = Array.from(imageMap.values());

  console.log(`\nCombined hosts: ${comImages.length} com + ${redImages.length} red = ${allImages.length} unique images`);

  // Filter out unpublished/scheduled images (future dates)
  const now = new Date();
  const publishedImages = allImages.filter(img => new Date(img.createdAt) <= now);
  const scheduledCount = allImages.length - publishedImages.length;

  if (scheduledCount > 0) {
    console.log(`\nFiltered out ${scheduledCount} unpublished/scheduled images (future dates)`);
  }

  // Count images with zero stats from bulk response
  let zeroStatsCount = 0;
  let hasStatsCount = 0;
  for (const img of publishedImages) {
    const total = (img.stats?.likeCount || 0) + (img.stats?.heartCount || 0) +
                  (img.stats?.laughCount || 0) + (img.stats?.cryCount || 0);
    if (total === 0) {
      zeroStatsCount++;
    } else {
      hasStatsCount++;
    }
  }
  console.log(`\nBulk fetch stats: ${hasStatsCount} with reactions, ${zeroStatsCount} with 0 reactions`);

  // Re-fetch accurate stats using tiered schedule
  const imagesWithStats = await refreshImageStats(publishedImages, tier);

  console.log(`\nTotal published images: ${imagesWithStats.length}`);
  return imagesWithStats;
}

/**
 * Read existing Gist data with better error handling
 */
async function readGistData() {
  try {
    console.log('Reading existing Gist data...');
    const gist = await octokit.gists.get({ gist_id: GIST_ID });

    // Check if stats.json file exists
    if (!gist.data.files['stats.json']) {
      throw new Error(
        `stats.json not found in Gist. Available files: ${Object.keys(gist.data.files).join(', ') || '(none)'}`
      );
    }

    const fileData = gist.data.files['stats.json'];
    let content;

    // Handle truncated files (GitHub API truncates large Gist files)
    if (fileData.truncated) {
      console.log('Gist file is truncated (too large for API response), fetching full content from raw_url...');
      const response = await fetch(fileData.raw_url);
      if (!response.ok) {
        throw new Error(`Failed to fetch full Gist content from raw_url: HTTP ${response.status}`);
      }
      content = await response.text();
      console.log(`Fetched full content: ${(content.length / 1024).toFixed(2)} KB`);
    } else {
      content = fileData.content;
    }

    // Check for truly empty/new Gist
    if (!content || content.trim() === '' || content.trim() === '{}') {
      console.log('Gist file is empty, starting fresh');
      return createEmptyStats();
    }

    // Parse and validate
    const data = JSON.parse(content);

    // Validate structure
    if (!data.totalSnapshots || !data.images) {
      console.error('ERROR: Gist data has invalid structure');
      console.error('Data structure:', Object.keys(data));
      throw new Error('Invalid Gist data structure - missing totalSnapshots or images arrays');
    }

    console.log(`Successfully read existing data: ${data.totalSnapshots.length} totalSnapshots, ${data.images.length} images`);
    const summary = inspectStatsData(data);
    console.log(`Validated existing data: ${summary.imageSnapshots} image snapshots, ${summary.postTitles} post titles`);
    return data;

  } catch (error) {
    // CRITICAL: Do NOT silently return empty stats on error!
    console.error('');
    console.error('═══════════════════════════════════════════════════════════');
    console.error('CRITICAL ERROR: Failed to read existing Gist data');
    console.error('═══════════════════════════════════════════════════════════');
    console.error('Error type:', error.name);
    console.error('Error message:', error.message);
    console.error('Stack trace:', error.stack);
    console.error('');
    console.error('This is a CRITICAL error because proceeding would OVERWRITE');
    console.error('all existing historical data with only the current snapshot.');
    console.error('');
    console.error('Possible causes:');
    console.error('  1. Network timeout or GitHub API issues');
    console.error('  2. Invalid GIST_TOKEN or insufficient permissions');
    console.error('  3. Gist was deleted or ID changed');
    console.error('  4. Gist file name is not "stats.json"');
    console.error('');
    console.error('ABORTING to prevent data loss.');
    console.error('═══════════════════════════════════════════════════════════');
    console.error('');

    // Exit with error code instead of returning empty stats
    process.exit(1);
  }
}

/**
 * Create empty stats structure
 */
function createEmptyStats() {
  return {
    formatVersion: CURRENT_FORMAT_VERSION,
    username: CIVITAI_USERNAME,
    lastUpdated: null,
    totalSnapshots: [],
    creatorSnapshots: [],
    images: [],
    postTitles: {}
  };
}

async function exportSafetyArtifact(name, data) {
  if (!SAFETY_EXPORT_DIR) return null;
  await mkdir(SAFETY_EXPORT_DIR, { recursive: true });
  const content = JSON.stringify(data);
  const filePath = path.join(SAFETY_EXPORT_DIR, `${name}.json`);
  await writeFile(filePath, content, 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  console.log(`Safety export: ${filePath} (${(content.length / 1024).toFixed(2)} KB, sha256 ${sha256})`);
  return { filePath, sha256, bytes: Buffer.byteLength(content) };
}

/**
 * Update Gist with new data
 */
async function updateGist(data) {
  try {
    // Compact output: pretty-printing inflated the file ~2-3x, undoing the
    // delta-encoding savings. The gist is machine-read, not human-read.
    const content = JSON.stringify(data);

    console.log('\nUpdating Gist...');
    console.log(`  Data size: ${(content.length / 1024).toFixed(2)} KB`);
    console.log(`  Total snapshots: ${data.totalSnapshots.length}`);
    console.log(`  Creator snapshots: ${(data.creatorSnapshots || []).length}`);
    console.log(`  Images: ${data.images.length}`);

    if (DRY_RUN) {
      console.log('DRY RUN: Gist update skipped');
      return;
    }

    await octokit.gists.update({
      gist_id: GIST_ID,
      files: {
        'stats.json': {
          content: content
        }
      }
    });

    console.log('✓ Gist updated successfully');
  } catch (error) {
    console.error('');
    console.error('═══════════════════════════════════════════════════════════');
    console.error('CRITICAL ERROR: Failed to update Gist');
    console.error('═══════════════════════════════════════════════════════════');
    console.error('Error:', error.message);
    console.error('');
    console.error('The data collection completed successfully but could not');
    console.error('be saved to the Gist. Possible causes:');
    console.error('  1. Network timeout');
    console.error('  2. Invalid GIST_TOKEN or revoked permissions');
    console.error('  3. Gist was deleted');
    console.error('  4. GitHub API issues');
    console.error('');
    console.error('Your historical data in the Gist has NOT been modified.');
    console.error('═══════════════════════════════════════════════════════════');
    console.error('');
    throw error;
  }
}

// Snapshot delta helpers (isDelta / resolveSnapshot / resolveAllSnapshots /
// encodeAsDeltas) come from the shared codec imported at the top of this file:
// extension/lib/snapshot-codec.js — one FIELDS table, used by collector AND extension.

/**
 * Process images and create current snapshot
 * Merges new snapshot data with existing image snapshots
 */
function processImages(apiImages, existingImages = [], now = new Date()) {
  const timestamp = now.toISOString();
  const retentionReferenceTime = now.getTime();

  // Create a map of existing images for quick lookup
  const existingImageMap = new Map(existingImages.map(img => [img.id, img]));

  // Calculate totals
  let totalLikes = 0;
  let totalHearts = 0;
  let totalLaughs = 0;
  let totalCries = 0;
  let totalComments = 0;
  let totalBuzz = 0;
  let totalCollects = 0;
  let totalViews = 0;

  // Bookkeeping for the integrity check in main(): every count change must be
  // explained by a new observation or the documented retention policy.
  let snapshotsAdded = 0;
  let retentionRemoved = 0;

  const images = apiImages.map(img => {
    const apiLikes = img.stats?.likeCount || 0;
    const apiHearts = img.stats?.heartCount || 0;
    const apiLaughs = img.stats?.laughCount || 0;
    const apiCries = img.stats?.cryCount || 0;
    const apiComments = img.stats?.commentCount || 0;
    const apiBuzz = img.stats?.buzzCount || 0;
    const apiCollects = img.stats?.collectCount || 0;
    const apiViews = img.stats?.viewCount || 0;

    // Get existing image data if available
    const existingImage = existingImageMap.get(String(img.id));
    let snapshots = existingImage?.snapshots || [];
    const storedSnapshotCount = snapshots.length;
    let addedForImage = 0;

    // Determine previous absolute values (resolve last snapshot if it's a delta)
    const lastSnapshot = snapshots.length > 0
      ? resolveSnapshot(snapshots, snapshots.length - 1)
      : null;

    // Clamp: never let stats decrease due to stale bulk API data.
    // Skipped for images with a requested clamp reset, so a previously
    // baked-in inflated value can come back down to the real one.
    const resetClamp = RESET_IMAGE_IDS.has(String(img.id));
    if (resetClamp) {
      console.log(`  Clamp reset for image ${img.id}: accepting API values as-is`);
    }
    const likes = resetClamp ? apiLikes : Math.max(apiLikes, lastSnapshot?.likes || 0);
    const hearts = resetClamp ? apiHearts : Math.max(apiHearts, lastSnapshot?.hearts || 0);
    const laughs = resetClamp ? apiLaughs : Math.max(apiLaughs, lastSnapshot?.laughs || 0);
    const cries = resetClamp ? apiCries : Math.max(apiCries, lastSnapshot?.cries || 0);
    const comments = resetClamp ? apiComments : Math.max(apiComments, lastSnapshot?.comments || 0);
    const buzz = resetClamp ? apiBuzz : Math.max(apiBuzz, lastSnapshot?.buzz || 0);
    const collects = resetClamp ? apiCollects : Math.max(apiCollects, lastSnapshot?.collects || 0);
    const views = resetClamp ? apiViews : Math.max(apiViews, lastSnapshot?.views || 0);

    if (lastSnapshot && (apiLikes < lastSnapshot.likes || apiHearts < lastSnapshot.hearts ||
        apiLaughs < lastSnapshot.laughs || apiCries < lastSnapshot.cries || apiComments < lastSnapshot.comments)) {
      console.log(`  Clamped stale API stats for image ${img.id}: API[${apiLikes},${apiHearts},${apiLaughs},${apiCries},${apiComments}] -> kept[${likes},${hearts},${laughs},${cries},${comments}]`);
    }

    totalLikes += likes;
    totalHearts += hearts;
    totalLaughs += laughs;
    totalCries += cries;
    totalComments += comments;
    totalBuzz += buzz;
    totalCollects += collects;
    totalViews += views;

    // Only store new snapshot if reactions actually changed (or it's the first snapshot)
    const hasChanged = !lastSnapshot ||
      lastSnapshot.likes !== likes ||
      lastSnapshot.hearts !== hearts ||
      lastSnapshot.laughs !== laughs ||
      lastSnapshot.cries !== cries ||
      lastSnapshot.comments !== comments ||
      lastSnapshot.buzz !== buzz ||
      lastSnapshot.collects !== collects ||
      lastSnapshot.views !== views;

    if (hasChanged) {
      if (!lastSnapshot) {
        // First snapshot — store absolute
        snapshots.push({ timestamp, likes, hearts, laughs, cries, comments, buzz, collects, views });
        snapshotsAdded++;
        addedForImage++;
      } else {
        // Subsequent snapshot — store as delta
        const delta = { timestamp };
        if (likes - lastSnapshot.likes) delta.dl = likes - lastSnapshot.likes;
        if (hearts - lastSnapshot.hearts) delta.dh = hearts - lastSnapshot.hearts;
        if (laughs - lastSnapshot.laughs) delta.dla = laughs - lastSnapshot.laughs;
        if (cries - lastSnapshot.cries) delta.dc = cries - lastSnapshot.cries;
        if (comments - lastSnapshot.comments) delta.dco = comments - lastSnapshot.comments;
        if (buzz - lastSnapshot.buzz) delta.dbu = buzz - lastSnapshot.buzz;
        if (collects - lastSnapshot.collects) delta.dcol = collects - lastSnapshot.collects;
        if (views - lastSnapshot.views) delta.dvi = views - lastSnapshot.views;
        if (Object.keys(delta).length > 1) {
          snapshots.push(delta);
          snapshotsAdded++;
          addedForImage++;
        }
      }
    }

    // Resolve, apply the documented age-based retention policy, then re-encode.
    let resolvedSnapshots = resolveAllSnapshots(snapshots);
    const beforeRetention = resolvedSnapshots.length;
    resolvedSnapshots = applyRetentionPolicy(resolvedSnapshots, retentionReferenceTime);
    const removedForImage = beforeRetention - resolvedSnapshots.length;
    retentionRemoved += removedForImage;
    snapshots = encodeAsDeltas(resolvedSnapshots);
    const expectedForImage = storedSnapshotCount + addedForImage - removedForImage;
    if (snapshots.length !== expectedForImage) {
      throw new Error(
        `Image ${img.id} snapshot accounting failed: ${storedSnapshotCount} stored + ` +
        `${addedForImage} added - ${removedForImage} retained-away != ` +
        `${snapshots.length} candidate`
      );
    }

    const host = img.host || 'com';
    return {
      id: String(img.id),
      name: img.meta?.prompt?.substring(0, 100) || `Image ${img.id}`,
      url: `${siteOriginForHost(host)}/images/${img.id}`,
      thumbnailUrl: img.url,
      createdAt: img.createdAt,
      host,
      // Naming inputs for the extension: postId links to the post's title,
      // baseModel is the fallback when a post has no title. Fall back to the
      // stored value so an incremental run can't blank them.
      postId: img.postId ?? existingImage?.postId ?? null,
      baseModel: img.baseModel ?? existingImage?.baseModel ?? null,
      // Synthesized entries (incremental discovery didn't reach them) were not
      // actually seen by the API this run: keep their lastSeenAt and stale flag.
      lastSeenAt: img._synthesized ? (existingImage?.lastSeenAt || null) : timestamp,
      stale: img._synthesized ? (existingImage?.stale || false) : false,
      snapshots
    };
  });

  // Include last-known stats for images not returned by API this run
  // This prevents false dips in the total when the API drops some images
  const apiImageIds = new Set(apiImages.map(img => String(img.id)));
  let missingImageCount = 0;

  for (const existing of existingImages) {
    if (!apiImageIds.has(existing.id) && existing.snapshots?.length > 0) {
      const last = resolveSnapshot(existing.snapshots, existing.snapshots.length - 1);
      totalLikes += last.likes || 0;
      totalHearts += last.hearts || 0;
      totalLaughs += last.laughs || 0;
      totalCries += last.cries || 0;
      totalComments += last.comments || 0;
      totalBuzz += last.buzz || 0;
      totalCollects += last.collects || 0;
      totalViews += last.views || 0;

      // Preserve the image in the output so its history isn't lost. Mark it
      // stale: no API (either host) returned it this run, so it's frozen at its
      // last-known value — likely migrated to civitai.red or removed.
      const host = existing.host || 'com';
      images.push({
        id: existing.id,
        name: existing.name,
        url: existing.url || `${siteOriginForHost(host)}/images/${existing.id}`,
        thumbnailUrl: existing.thumbnailUrl,
        createdAt: existing.createdAt,
        host,
        postId: existing.postId ?? null,
        baseModel: existing.baseModel ?? null,
        lastSeenAt: existing.lastSeenAt || null,
        stale: true,
        snapshots: existing.snapshots // keep existing snapshots as-is
      });
      missingImageCount++;
    }
  }

  if (missingImageCount > 0) {
    console.log(`\n⚠️  ${missingImageCount} images from history not found in API response (stats carried forward)`);
  }

  const newImages = images.filter(img => img.snapshots.length === 1).length;
  const multiSnapshot = images.filter(img => img.snapshots.length > 1).length;
  console.log(`\nImage history: ${newImages} new, ${multiSnapshot} with prior history`);

  const redCount = images.filter(img => img.host === 'red').length;
  const staleCount = images.filter(img => img.stale).length;
  console.log(`Host split: ${images.length - redCount} com, ${redCount} red | ${staleCount} stale (frozen, not seen this run)`);

  const totalSnapshot = {
    timestamp,
    likes: totalLikes,
    hearts: totalHearts,
    laughs: totalLaughs,
    cries: totalCries,
    comments: totalComments,
    buzz: totalBuzz,
    collects: totalCollects,
    views: totalViews,
    imageCount: images.length
  };

  return { images, totalSnapshot, snapshotsAdded, retentionRemoved };
}

/**
 * Main execution
 */
async function main() {
  try {
    validateRuntimeConfig();
    octokit = new Octokit({ auth: GIST_TOKEN });

    console.log('=== Civitai Stats Collector ===');
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Username: ${CIVITAI_USERNAME}`);
    logRuntimeConfig();
    if (REFRESH_TIER_OVERRIDE && REFRESH_TIER_OVERRIDE !== 'auto') {
      console.log(`Refresh tier override: ${REFRESH_TIER_OVERRIDE} (manually triggered)`);
    }
    console.log('');

    // Read existing Gist data FIRST: fail fast on gist problems before touching
    // the Civitai API, and feed known image IDs into incremental discovery.
    const existingData = await readGistData();
    const originalData = structuredClone(existingData);
    inspectStatsData(originalData);
    // Legacy files did not have this field. Normalize only the candidate;
    // originalData remains representative for the transition safety check.
    existingData.creatorSnapshots = existingData.creatorSnapshots || [];
    await exportSafetyArtifact('stats-before', originalData);

    // Fetch all user images from Civitai
    const apiImages = await fetchAllUserImages(CIVITAI_USERNAME, existingData.images);

    if (apiImages.length === 0) {
      console.log('No images found for user. Exiting.');
      return;
    }

    // Log the data we read for debugging
    if (existingData.totalSnapshots.length === 0 && existingData.images.length === 0) {
      console.log('⚠️  WARNING: Starting with empty data (no existing history found)');
      console.log('   If this is unexpected, check your GIST_ID and ensure the Gist exists.');
    } else {
      console.log(`✓ Loaded existing history successfully`);

      // Show some sample data to verify it's real
      if (existingData.totalSnapshots.length > 0) {
        const latest = resolveSnapshot(existingData.totalSnapshots, existingData.totalSnapshots.length - 1);
        console.log(`  Latest snapshot: ${latest.timestamp}`);
        console.log(`  Stats: ${latest.likes} likes, ${latest.hearts} hearts`);
      }

      if (existingData.images.length > 0) {
        const sampleImage = existingData.images[0];
        console.log(`  Sample image: ${sampleImage.id} with ${sampleImage.snapshots?.length || 0} snapshots`);
      }
    }

    console.log(`\nExisting data: ${existingData.totalSnapshots.length} totalSnapshots, ${existingData.images.length} images`);

    // Snapshot count before the merge — baseline for the integrity check below
    const preMergeSnapshotCount = existingData.images.reduce(
      (sum, img) => sum + (img.snapshots?.length || 0), 0);

    // Process images with existing data to merge snapshots
    const { images, totalSnapshot, snapshotsAdded, retentionRemoved } =
      processImages(apiImages, existingData.images);
    const retentionReferenceTime = Date.parse(totalSnapshot.timestamp);

    console.log('\nSnapshot created:');
    console.log(`  Images: ${totalSnapshot.imageCount}`);
    console.log(`  Likes: ${totalSnapshot.likes}`);
    console.log(`  Hearts: ${totalSnapshot.hearts}`);
    console.log(`  Laughs: ${totalSnapshot.laughs}`);
    console.log(`  Cries: ${totalSnapshot.cries}`);
    console.log(`  Comments: ${totalSnapshot.comments}`);
    console.log(`  Buzz: ${totalSnapshot.buzz}`);
    console.log(`  Collects: ${totalSnapshot.collects}`);
    console.log(`  Views: ${totalSnapshot.views}`);

    // Append new total snapshot (as delta if possible)
    if (existingData.totalSnapshots.length > 0) {
      const prevTotal = resolveSnapshot(existingData.totalSnapshots, existingData.totalSnapshots.length - 1);

      // Clamp: total should never decrease (same rationale as per-image clamping)
      // If the API missed images, the carried-forward stats (Change 2) should prevent this,
      // but this is a safety net in case anything slips through.
      // Skipped when a clamp reset was requested: the whole point of a reset run
      // is to let a corrected (lower) image value flow into the total.
      if (RESET_IMAGE_IDS.size === 0) {
        totalSnapshot.likes = Math.max(totalSnapshot.likes, prevTotal.likes);
        totalSnapshot.hearts = Math.max(totalSnapshot.hearts, prevTotal.hearts);
        totalSnapshot.laughs = Math.max(totalSnapshot.laughs, prevTotal.laughs);
        totalSnapshot.cries = Math.max(totalSnapshot.cries, prevTotal.cries);
        totalSnapshot.comments = Math.max(totalSnapshot.comments, prevTotal.comments);
        totalSnapshot.buzz = Math.max(totalSnapshot.buzz, prevTotal.buzz || 0);
        totalSnapshot.collects = Math.max(totalSnapshot.collects, prevTotal.collects || 0);
        totalSnapshot.views = Math.max(totalSnapshot.views, prevTotal.views || 0);
      }

      const delta = { timestamp: totalSnapshot.timestamp, imageCount: totalSnapshot.imageCount };
      if (totalSnapshot.likes - prevTotal.likes) delta.dl = totalSnapshot.likes - prevTotal.likes;
      if (totalSnapshot.hearts - prevTotal.hearts) delta.dh = totalSnapshot.hearts - prevTotal.hearts;
      if (totalSnapshot.laughs - prevTotal.laughs) delta.dla = totalSnapshot.laughs - prevTotal.laughs;
      if (totalSnapshot.cries - prevTotal.cries) delta.dc = totalSnapshot.cries - prevTotal.cries;
      if (totalSnapshot.comments - prevTotal.comments) delta.dco = totalSnapshot.comments - prevTotal.comments;
      if (totalSnapshot.buzz - (prevTotal.buzz || 0)) delta.dbu = totalSnapshot.buzz - (prevTotal.buzz || 0);
      if (totalSnapshot.collects - (prevTotal.collects || 0)) delta.dcol = totalSnapshot.collects - (prevTotal.collects || 0);
      if (totalSnapshot.views - (prevTotal.views || 0)) delta.dvi = totalSnapshot.views - (prevTotal.views || 0);
      if (!delta.dl && !delta.dh && !delta.dla && !delta.dc && !delta.dco && !delta.dbu && !delta.dcol && !delta.dvi) {
        delta._d = 1;
      }
      existingData.totalSnapshots.push(delta);
    } else {
      existingData.totalSnapshots.push(totalSnapshot);
    }

    // Resolve, apply the same retention policy to totals, and re-encode.
    const totalSnapshotsBeforeRetention = existingData.totalSnapshots.length;
    let resolvedTotal = resolveAllSnapshots(existingData.totalSnapshots);
    // Preserve imageCount through resolve/encode cycle
    for (let i = 0; i < resolvedTotal.length; i++) {
      if (existingData.totalSnapshots[i]?.imageCount != null) {
        resolvedTotal[i].imageCount = existingData.totalSnapshots[i].imageCount;
      }
    }
    resolvedTotal = applyRetentionPolicy(resolvedTotal, retentionReferenceTime);
    const totalRetentionRemoved = totalSnapshotsBeforeRetention - resolvedTotal.length;
    existingData.totalSnapshots = encodeAsDeltas(resolvedTotal);
    // Re-attach imageCount to encoded snapshots
    for (let i = 0; i < existingData.totalSnapshots.length; i++) {
      if (resolvedTotal[i]?.imageCount != null) {
        existingData.totalSnapshots[i].imageCount = resolvedTotal[i].imageCount;
      }
    }
    if (totalRetentionRemoved > 0) {
      console.log(`\nRetention policy (total): removed ${totalRetentionRemoved} superseded observations`);
    }

    // Creator follower totals are independent best-effort observations. Never
    // invent zero on auth/API failures: keep every previous point and let the
    // next scheduled run try again. Decreases are legitimate net unfollows and
    // are deliberately preserved as absolute values.
    try {
      const followers = await fetchCreatorFollowers(CIVITAI_USERNAME);
      const creatorResult = appendCreatorSnapshot(
        existingData.creatorSnapshots,
        totalSnapshot.timestamp,
        followers,
        retentionReferenceTime
      );
      existingData.creatorSnapshots = creatorResult.snapshots;
      console.log(`\nCreator snapshot: ${followers} followers`);
      if (creatorResult.retentionRemoved > 0) {
        console.log(
          `Retention policy (creator): removed ${creatorResult.retentionRemoved} superseded observations`
        );
      }
    } catch (error) {
      console.log(`\nFollower collection failed (history preserved): ${error.message}`);
    }

    // Resolve post titles (best-effort — names are cosmetic, never worth
    // failing a stats run over).
    try {
      existingData.postTitles = await refreshPostTitles(
        images, existingData.postTitles, getRefreshTier());
    } catch (error) {
      console.log(`\n⚠️  Post title resolution failed (continuing): ${error.message}`);
      existingData.postTitles = existingData.postTitles || {};
    }

    // Update images with merged snapshots
    existingData.images = images;
    existingData.formatVersion = CURRENT_FORMAT_VERSION;
    existingData.username = CIVITAI_USERNAME;
    existingData.lastUpdated = totalSnapshot.timestamp;

    // SAFETY CHECK: Prevent catastrophic data loss.
    // Exact accounting: per-image snapshots may only be added (one new data
    // point per changed image) or removed by retention. Ending below that
    // floor means the merge dropped history — abort before overwriting.
    const postMergeSnapshotCount = images.reduce(
      (sum, img) => sum + (img.snapshots?.length || 0), 0);
    const expectedSnapshotCount = preMergeSnapshotCount + snapshotsAdded - retentionRemoved;

    console.log('\nData integrity check:');
    console.log(`  Image snapshots before merge: ${preMergeSnapshotCount}`);
    console.log(`  Added this run: ${snapshotsAdded}, removed by retention: ${retentionRemoved}`);
    console.log(`  Image snapshots after merge: ${postMergeSnapshotCount} (expected: ${expectedSnapshotCount})`);

    if (postMergeSnapshotCount !== expectedSnapshotCount) {
      console.error('');
      console.error('═══════════════════════════════════════════════════════════');
      console.error('DATA LOSS DETECTED!');
      console.error('═══════════════════════════════════════════════════════════');
      console.error(`Expected: ${expectedSnapshotCount} image snapshots`);
      console.error(`  (${preMergeSnapshotCount} before + ${snapshotsAdded} added - ` +
        `${retentionRemoved} retained-away)`);
      console.error(`Actual: ${postMergeSnapshotCount}`);
      console.error('');
      console.error('This indicates a critical bug in data merging.');
      console.error('ABORTING to prevent overwriting good data with incomplete data.');
      console.error('═══════════════════════════════════════════════════════════');
      console.error('');
      process.exit(1);
    }

    console.log('✓ Data integrity check: PASSED');

    const transition = assertSafeTransition(originalData, existingData, {
      retentionReferenceTime,
      candidateTimestamp: totalSnapshot.timestamp
    });
    console.log('Candidate transition check:');
    console.log(`  Images: ${transition.before.images} -> ${transition.after.images}`);
    console.log(
      `  Creator snapshots: ${transition.before.creatorSnapshots} -> ${transition.after.creatorSnapshots}`
    );
    console.log(`  Post titles: ${transition.before.postTitles} -> ${transition.after.postTitles}`);
    console.log('✓ Candidate transition check: PASSED');
    await exportSafetyArtifact('stats-candidate', existingData);

    // Update Gist
    await updateGist(existingData);

    console.log('\n=== Complete ===');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) main();

export {
  aggregateSnapshots,
  appendCreatorSnapshot,
  applyRetentionPolicy,
  determineRefreshTier,
  extractCreatorFollowers,
  extractPostTitleFromHtml,
  processImages,
  retryAfterDelayMs
};
