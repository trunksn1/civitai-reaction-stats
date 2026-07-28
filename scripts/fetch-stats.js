import { Octokit } from '@octokit/rest';
// Shared snapshot codec — same file the extension loads (single source of truth
// for the delta format). Lives under extension/lib/ because Chrome cannot load
// files from outside the extension root.
import SnapshotCodec from '../extension/lib/snapshot-codec.js';

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
// Escape hatch for the never-decrease clamp: images listed here (comma-separated
// IDs) take the API's fresh values as-is for this run, so an inflated stat that
// got baked in by the clamp can be corrected. See README "Fixing inflated stats".
const RESET_IMAGE_IDS = new Set(
  (process.env.RESET_IMAGE_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
// Force a full discovery sweep (all pages, all NSFW levels, both hosts) on a
// daily-tier run. Monthly/quarterly tiers and first runs always sweep fully.
const FULL_DISCOVERY = (process.env.FULL_DISCOVERY || '').toLowerCase() === 'true';

// Validate required environment variables
if (!GIST_ID || !GIST_TOKEN || !CIVITAI_USERNAME) {
  console.error('Missing required environment variables:');
  if (!GIST_ID) console.error('  - GIST_ID');
  if (!GIST_TOKEN) console.error('  - GIST_TOKEN');
  if (!CIVITAI_USERNAME) console.error('  - CIVITAI_USERNAME');
  process.exit(1);
}

if (CIVITAI_API_KEY) {
  console.log('Using Civitai API key for authenticated requests');
} else {
  console.log('No CIVITAI_API_KEY set - using unauthenticated requests');
}

if (CIVITAI_RED_ENABLED) {
  console.log(`civitai.red capture: enabled${process.env.CIVITAI_RED_API_KEY ? ' (dedicated key)' : ' (using .com key)'}`);
} else {
  console.log('civitai.red capture: disabled');
}

if (RESET_IMAGE_IDS.size > 0) {
  console.log(`Clamp reset requested for ${RESET_IMAGE_IDS.size} image(s): ${[...RESET_IMAGE_IDS].join(', ')}`);
}

const octokit = new Octokit({ auth: GIST_TOKEN });

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

// Data retention thresholds
const HOURLY_RETENTION_DAYS = 7;
const SIX_HOUR_RETENTION_DAYS = 30;

/**
 * Fetch with exponential backoff retry
 */
async function fetchWithRetry(url, retries = MAX_RETRIES, backoff = INITIAL_BACKOFF_MS) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const headers = {};
      // Pick the auth key by host so .red requests use the .red key (which may
      // differ from the .com key, though it falls back to it).
      const key = url.includes('civitai.red') ? CIVITAI_RED_API_KEY : CIVITAI_API_KEY;
      if (key) {
        headers['Authorization'] = `Bearer ${key}`;
      }
      const response = await fetch(url, { headers });

      if (response.status === 429) {
        // Rate limited - wait and retry
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : backoff;
        console.log(`Rate limited. Waiting ${waitTime}ms before retry ${attempt}/${retries}`);
        await sleep(waitTime);
        backoff *= 2;
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      if (attempt === retries) {
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
 * Fetch stats for a single image by ID using the tRPC API.
 * The tRPC endpoint returns additional fields (buzz, collects, views)
 * that the public REST API does not expose.
 */
async function fetchImageStats(imageId, host = 'com') {
  const input = { json: { id: Number(imageId) } };
  const url = `${siteOriginForHost(host)}/api/trpc/image.get?input=${encodeURIComponent(JSON.stringify(input))}`;
  try {
    const data = await fetchWithRetry(url);
    const item = data?.result?.data?.json;
    if (item && item.stats) {
      const s = item.stats;
      return {
        likeCount: s.likeCountAllTime || 0,
        heartCount: s.heartCountAllTime || 0,
        laughCount: s.laughCountAllTime || 0,
        cryCount: s.cryCountAllTime || 0,
        commentCount: s.commentCountAllTime || 0,
        buzzCount: s.tippedAmountCountAllTime || 0,
        collectCount: s.collectedCountAllTime || 0,
        viewCount: s.viewCountAllTime || 0
      };
    }
  } catch (error) {
    console.log(`  Warning: Failed to fetch stats for image ${imageId}: ${error.message}`);
  }
  return null;
}

/**
 * Determine which tier of refresh to run based on current date or override
 * - Daily: images from last 30 days + any with 0 stats
 * - Monthly (1st of month): also images from 1-6 months ago
 * - Quarterly (1st of month in Jan/Apr/Jul/Oct): ALL images
 */
function getRefreshTier() {
  // Check for manual override from workflow_dispatch input
  if (REFRESH_TIER_OVERRIDE && REFRESH_TIER_OVERRIDE !== 'auto') {
    console.log(`Using manual refresh tier override: ${REFRESH_TIER_OVERRIDE}`);
    return REFRESH_TIER_OVERRIDE;
  }

  // Auto: determine tier based on date (UTC — matches the Actions cron).
  // Escalated tiers fire only at hour 0: the job runs hourly and would
  // otherwise repeat the expensive full refresh 24 times on tier days.
  const now = new Date();
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

  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < refreshList.length; i += STATS_BATCH_SIZE) {
    const batch = refreshList.slice(i, i + STATS_BATCH_SIZE);

    const results = await Promise.all(
      batch.map(img => fetchImageStats(img.id, img.host || 'com'))
    );

    for (let j = 0; j < batch.length; j++) {
      const stats = results[j];
      if (stats) {
        const bulkStats = batch[j].stats || {};
        // Keep the higher value for each field — individual refresh should
        // correct understated bulk stats, not overwrite with stale/lower values.
        // Exception: a requested clamp reset trusts the fresh fetch as-is.
        const mergedStats = RESET_IMAGE_IDS.has(String(batch[j].id)) ? { ...stats } : {
          likeCount: Math.max(stats.likeCount || 0, bulkStats.likeCount || 0),
          heartCount: Math.max(stats.heartCount || 0, bulkStats.heartCount || 0),
          laughCount: Math.max(stats.laughCount || 0, bulkStats.laughCount || 0),
          cryCount: Math.max(stats.cryCount || 0, bulkStats.cryCount || 0),
          commentCount: Math.max(stats.commentCount || 0, bulkStats.commentCount || 0),
          buzzCount: Math.max(stats.buzzCount || 0, bulkStats.buzzCount || 0),
          collectCount: Math.max(stats.collectCount || 0, bulkStats.collectCount || 0),
          viewCount: Math.max(stats.viewCount || 0, bulkStats.viewCount || 0),
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
      console.log('Warning: stats.json file not found in Gist');
      console.log('Available files:', Object.keys(gist.data.files).join(', '));
      console.log('Starting with empty stats');
      return createEmptyStats();
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
    username: CIVITAI_USERNAME,
    lastUpdated: null,
    totalSnapshots: [],
    images: []
  };
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
    console.log(`  Images: ${data.images.length}`);

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

/**
 * Aggregate snapshots to reduce data size
 * Groups snapshots into intervals and takes the last value in each interval
 */
function aggregateSnapshots(snapshots, intervalHours) {
  if (snapshots.length === 0) return [];

  const intervalMs = intervalHours * 60 * 60 * 1000;
  const aggregated = [];
  let currentBucket = null;
  let currentBucketStart = null;

  for (const snapshot of snapshots) {
    const timestamp = new Date(snapshot.timestamp).getTime();
    const bucketStart = Math.floor(timestamp / intervalMs) * intervalMs;

    if (currentBucketStart !== bucketStart) {
      if (currentBucket) {
        aggregated.push(currentBucket);
      }
      currentBucketStart = bucketStart;
    }
    // Always keep the latest snapshot in the bucket
    currentBucket = snapshot;
  }

  if (currentBucket) {
    aggregated.push(currentBucket);
  }

  return aggregated;
}

/**
 * Apply data retention policy to snapshots
 */
function applyRetentionPolicy(snapshots) {
  const now = Date.now();
  const hourlyThreshold = now - (HOURLY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const sixHourThreshold = now - (SIX_HOUR_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Separate snapshots into retention buckets
  const hourlySnapshots = [];
  const sixHourSnapshots = [];
  const dailySnapshots = [];

  for (const snapshot of snapshots) {
    const timestamp = new Date(snapshot.timestamp).getTime();

    if (timestamp >= hourlyThreshold) {
      // Last 7 days: keep hourly
      hourlySnapshots.push(snapshot);
    } else if (timestamp >= sixHourThreshold) {
      // 7-30 days: aggregate to 6-hour intervals
      sixHourSnapshots.push(snapshot);
    } else {
      // Beyond 30 days: aggregate to daily
      dailySnapshots.push(snapshot);
    }
  }

  // Aggregate older data
  const aggregatedSixHour = aggregateSnapshots(sixHourSnapshots, 6);
  const aggregatedDaily = aggregateSnapshots(dailySnapshots, 24);

  // Combine all snapshots, sorted by timestamp
  const result = [...aggregatedDaily, ...aggregatedSixHour, ...hourlySnapshots];
  result.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return result;
}

// Snapshot delta helpers (isDelta / resolveSnapshot / resolveAllSnapshots /
// encodeAsDeltas) come from the shared codec imported at the top of this file:
// extension/lib/snapshot-codec.js — one FIELDS table, used by collector AND extension.

/**
 * Process images and create current snapshot
 * Merges new snapshot data with existing image snapshots
 */
function processImages(apiImages, existingImages = []) {
  const timestamp = new Date().toISOString();

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

  // Bookkeeping for the integrity check in main(): snapshots may only be
  // added (new data point) or removed by retention — never lost in the merge.
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
        }
      }
    }

    // Apply retention: resolve to absolute first, retain, then re-encode as deltas
    let resolvedSnapshots = resolveAllSnapshots(snapshots);
    const beforeRetention = resolvedSnapshots.length;
    resolvedSnapshots = applyRetentionPolicy(resolvedSnapshots);
    retentionRemoved += beforeRetention - resolvedSnapshots.length;
    snapshots = encodeAsDeltas(resolvedSnapshots);

    const host = img.host || 'com';
    return {
      id: String(img.id),
      name: img.meta?.prompt?.substring(0, 100) || `Image ${img.id}`,
      url: `${siteOriginForHost(host)}/images/${img.id}`,
      thumbnailUrl: img.url,
      createdAt: img.createdAt,
      host,
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
  console.log('=== Civitai Stats Collector ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Username: ${CIVITAI_USERNAME}`);
  console.log('');
  if (REFRESH_TIER_OVERRIDE && REFRESH_TIER_OVERRIDE !== 'auto') {
    console.log(`Refresh tier override: ${REFRESH_TIER_OVERRIDE} (manually triggered)`);
  }
  console.log('');

  try {
    // Read existing Gist data FIRST: fail fast on gist problems before touching
    // the Civitai API, and feed known image IDs into incremental discovery.
    const existingData = await readGistData();

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

    // Apply retention: resolve to absolute, retain, re-encode as deltas
    const snapshotsBefore = existingData.totalSnapshots.length;
    let resolvedTotal = resolveAllSnapshots(existingData.totalSnapshots);
    // Preserve imageCount through resolve/encode cycle
    for (let i = 0; i < resolvedTotal.length; i++) {
      if (existingData.totalSnapshots[i]?.imageCount != null) {
        resolvedTotal[i].imageCount = existingData.totalSnapshots[i].imageCount;
      }
    }
    resolvedTotal = applyRetentionPolicy(resolvedTotal);
    existingData.totalSnapshots = encodeAsDeltas(resolvedTotal);
    // Re-attach imageCount to encoded snapshots
    for (let i = 0; i < existingData.totalSnapshots.length; i++) {
      if (resolvedTotal[i]?.imageCount != null) {
        existingData.totalSnapshots[i].imageCount = resolvedTotal[i].imageCount;
      }
    }
    const snapshotsAfter = existingData.totalSnapshots.length;

    if (snapshotsBefore !== snapshotsAfter) {
      console.log(`\nRetention policy (total): ${snapshotsBefore} -> ${snapshotsAfter} snapshots`);
    }

    // Update images with merged snapshots
    existingData.images = images;
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

    if (postMergeSnapshotCount < expectedSnapshotCount) {
      console.error('');
      console.error('═══════════════════════════════════════════════════════════');
      console.error('DATA LOSS DETECTED!');
      console.error('═══════════════════════════════════════════════════════════');
      console.error(`Expected: ${expectedSnapshotCount} image snapshots`);
      console.error(`  (${preMergeSnapshotCount} before + ${snapshotsAdded} added - ${retentionRemoved} retention)`);
      console.error(`Actual: ${postMergeSnapshotCount}`);
      console.error('');
      console.error('This indicates a critical bug in data merging.');
      console.error('ABORTING to prevent overwriting good data with incomplete data.');
      console.error('═══════════════════════════════════════════════════════════');
      console.error('');
      process.exit(1);
    }

    if (postMergeSnapshotCount > expectedSnapshotCount) {
      console.log(`  Note: ${postMergeSnapshotCount - expectedSnapshotCount} more snapshots than expected (harmless, but worth a look)`);
    }
    console.log('✓ Data integrity check: PASSED');

    // Update Gist
    await updateGist(existingData);

    console.log('\n=== Complete ===');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
