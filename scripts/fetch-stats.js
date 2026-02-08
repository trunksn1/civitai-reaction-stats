import { Octokit } from '@octokit/rest';

// Environment variables
const GIST_ID = process.env.GIST_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;
const CIVITAI_USERNAME = process.env.CIVITAI_USERNAME;
const CIVITAI_API_KEY = process.env.CIVITAI_API_KEY; // Optional - may help get accurate stats
const REFRESH_TIER_OVERRIDE = process.env.REFRESH_TIER; // Optional: 'auto', 'daily', 'monthly', 'quarterly'

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

const octokit = new Octokit({ auth: GIST_TOKEN });

// Constants
const CIVITAI_API_BASE = 'https://civitai.com/api/v1';
const IMAGES_PER_PAGE = 200;
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
      if (CIVITAI_API_KEY) {
        headers['Authorization'] = `Bearer ${CIVITAI_API_KEY}`;
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
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch stats for a single image by ID
 * The public API only returns accurate stats when querying by imageId
 */
async function fetchImageStats(imageId) {
  const url = `${CIVITAI_API_BASE}/images?imageId=${imageId}`;
  try {
    const data = await fetchWithRetry(url);
    if (data.items && data.items.length > 0) {
      return data.items[0].stats || null;
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

  // Auto: determine tier based on date
  const now = new Date();
  const dayOfMonth = now.getDate();
  const month = now.getMonth(); // 0-indexed

  if (dayOfMonth === 1 && month % 3 === 0) {
    return 'quarterly';
  }
  if (dayOfMonth === 1) {
    return 'monthly';
  }
  return 'daily';
}

/**
 * Refresh image stats individually based on a tiered schedule.
 * The Civitai bulk API returns stale stats, so we re-fetch individually
 * on a smart schedule to keep stats fresh without excessive API calls.
 */
async function refreshImageStats(images) {
  const tier = getRefreshTier();
  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const sixMonthsAgo = new Date(now - 180 * 24 * 60 * 60 * 1000);

  // Determine which images to refresh
  const toRefresh = new Set();

  for (const img of images) {
    const total = (img.stats?.likeCount || 0) + (img.stats?.heartCount || 0) +
                  (img.stats?.laughCount || 0) + (img.stats?.cryCount || 0);
    const createdAt = new Date(img.createdAt);

    // Always: images with 0 stats or from last 30 days
    if (total === 0 || createdAt >= thirtyDaysAgo) {
      toRefresh.add(img);
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
      batch.map(img => fetchImageStats(img.id))
    );

    for (let j = 0; j < batch.length; j++) {
      const stats = results[j];
      if (stats) {
        const bulkStats = batch[j].stats || {};
        // Keep the higher value for each field — individual refresh should
        // correct understated bulk stats, not overwrite with stale/lower values
        const mergedStats = {
          likeCount: Math.max(stats.likeCount || 0, bulkStats.likeCount || 0),
          heartCount: Math.max(stats.heartCount || 0, bulkStats.heartCount || 0),
          laughCount: Math.max(stats.laughCount || 0, bulkStats.laughCount || 0),
          cryCount: Math.max(stats.cryCount || 0, bulkStats.cryCount || 0),
          commentCount: Math.max(stats.commentCount || 0, bulkStats.commentCount || 0),
        };
        const oldTotal = (bulkStats.likeCount || 0) + (bulkStats.heartCount || 0) +
                         (bulkStats.laughCount || 0) + (bulkStats.cryCount || 0);
        const newTotal = (mergedStats.likeCount || 0) + (mergedStats.heartCount || 0) +
                         (mergedStats.laughCount || 0) + (mergedStats.cryCount || 0);
        batch[j].stats = mergedStats;
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
async function fetchAllPages(startUrl, label) {
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
async function fetchAllUserImages(username) {
  const baseUrl = `${CIVITAI_API_BASE}/images?username=${encodeURIComponent(username)}&limit=${IMAGES_PER_PAGE}&sort=Newest&period=AllTime`;

  // Fetch each NSFW level separately because the API doesn't reliably return all in one call.
  // nsfw=true only returns Mature+X, omitting Soft (PG-13). See: github.com/civitai/civitai/issues/1795
  console.log(`Fetching images for user: ${username}`);

  const nsfwLevels = [
    { param: '',             label: 'SFW (None)' },
    { param: '&nsfw=Soft',   label: 'Soft (PG-13)' },
    { param: '&nsfw=Mature', label: 'Mature (R)' },
    { param: '&nsfw=X',     label: 'X' },
  ];

  const results = [];
  for (const { param, label } of nsfwLevels) {
    const images = await fetchAllPages(`${baseUrl}${param}`, label);
    results.push({ label, count: images.length, images });
  }

  // Merge and deduplicate by image ID
  const imageMap = new Map();
  for (const { images } of results) {
    for (const img of images) {
      imageMap.set(img.id, img);
    }
  }
  const allImages = Array.from(imageMap.values());

  const breakdown = results.map(r => `${r.count} ${r.label}`).join(' + ');
  console.log(`\nCombined: ${breakdown} = ${allImages.length} unique images`);

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
  const imagesWithStats = await refreshImageStats(publishedImages);

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
    const content = JSON.stringify(data, null, 2);

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

/**
 * Check if a snapshot is delta-encoded (has any d* keys)
 */
function isDelta(snapshot) {
  return snapshot && ('dl' in snapshot || 'dh' in snapshot ||
         'dla' in snapshot || 'dc' in snapshot || 'dco' in snapshot || '_d' in snapshot);
}

/**
 * Resolve a single snapshot at a given index to absolute values
 * by walking backward to find the nearest absolute snapshot and applying deltas forward
 */
function resolveSnapshot(snapshots, index) {
  let base = { likes: 0, hearts: 0, laughs: 0, cries: 0, comments: 0 };
  let startIdx = 0;

  for (let i = index; i >= 0; i--) {
    if (!isDelta(snapshots[i])) {
      base = {
        likes: snapshots[i].likes || 0,
        hearts: snapshots[i].hearts || 0,
        laughs: snapshots[i].laughs || 0,
        cries: snapshots[i].cries || 0,
        comments: snapshots[i].comments || 0
      };
      startIdx = i + 1;
      break;
    }
  }

  for (let i = startIdx; i <= index; i++) {
    const s = snapshots[i];
    if (isDelta(s)) {
      base.likes += s.dl || 0;
      base.hearts += s.dh || 0;
      base.laughs += s.dla || 0;
      base.cries += s.dc || 0;
      base.comments += s.dco || 0;
    }
  }

  return { timestamp: snapshots[index].timestamp, ...base };
}

/**
 * Resolve all snapshots in an array to absolute values
 */
function resolveAllSnapshots(snapshots) {
  const result = [];
  let current = { likes: 0, hearts: 0, laughs: 0, cries: 0, comments: 0 };

  for (const s of snapshots) {
    if (isDelta(s)) {
      current = {
        likes: current.likes + (s.dl || 0),
        hearts: current.hearts + (s.dh || 0),
        laughs: current.laughs + (s.dla || 0),
        cries: current.cries + (s.dc || 0),
        comments: current.comments + (s.dco || 0)
      };
    } else {
      current = {
        likes: s.likes || 0,
        hearts: s.hearts || 0,
        laughs: s.laughs || 0,
        cries: s.cries || 0,
        comments: s.comments || 0
      };
    }
    result.push({ timestamp: s.timestamp, ...current });
  }
  return result;
}

/**
 * Encode an array of absolute snapshots as deltas (first stays absolute, rest become deltas)
 */
function encodeAsDeltas(absoluteSnapshots) {
  if (absoluteSnapshots.length === 0) return [];
  const result = [absoluteSnapshots[0]];
  for (let i = 1; i < absoluteSnapshots.length; i++) {
    const prev = absoluteSnapshots[i - 1];
    const curr = absoluteSnapshots[i];
    const delta = { timestamp: curr.timestamp };
    if (curr.likes - prev.likes) delta.dl = curr.likes - prev.likes;
    if (curr.hearts - prev.hearts) delta.dh = curr.hearts - prev.hearts;
    if (curr.laughs - prev.laughs) delta.dla = curr.laughs - prev.laughs;
    if (curr.cries - prev.cries) delta.dc = curr.cries - prev.cries;
    if (curr.comments - prev.comments) delta.dco = curr.comments - prev.comments;
    // Mark as delta even when all changes are zero, so resolvers don't mistake it for absolute
    if (!delta.dl && !delta.dh && !delta.dla && !delta.dc && !delta.dco) {
      delta._d = 1;
    }
    result.push(delta);
  }
  return result;
}

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

  const images = apiImages.map(img => {
    const apiLikes = img.stats?.likeCount || 0;
    const apiHearts = img.stats?.heartCount || 0;
    const apiLaughs = img.stats?.laughCount || 0;
    const apiCries = img.stats?.cryCount || 0;
    const apiComments = img.stats?.commentCount || 0;

    // Get existing image data if available
    const existingImage = existingImageMap.get(String(img.id));
    let snapshots = existingImage?.snapshots || [];

    // Determine previous absolute values (resolve last snapshot if it's a delta)
    const lastSnapshot = snapshots.length > 0
      ? resolveSnapshot(snapshots, snapshots.length - 1)
      : null;

    // Clamp: never let stats decrease due to stale bulk API data
    const likes = Math.max(apiLikes, lastSnapshot?.likes || 0);
    const hearts = Math.max(apiHearts, lastSnapshot?.hearts || 0);
    const laughs = Math.max(apiLaughs, lastSnapshot?.laughs || 0);
    const cries = Math.max(apiCries, lastSnapshot?.cries || 0);
    const comments = Math.max(apiComments, lastSnapshot?.comments || 0);

    if (lastSnapshot && (apiLikes < lastSnapshot.likes || apiHearts < lastSnapshot.hearts ||
        apiLaughs < lastSnapshot.laughs || apiCries < lastSnapshot.cries || apiComments < lastSnapshot.comments)) {
      console.log(`  Clamped stale API stats for image ${img.id}: API[${apiLikes},${apiHearts},${apiLaughs},${apiCries},${apiComments}] -> kept[${likes},${hearts},${laughs},${cries},${comments}]`);
    }

    totalLikes += likes;
    totalHearts += hearts;
    totalLaughs += laughs;
    totalCries += cries;
    totalComments += comments;

    // Only store new snapshot if reactions actually changed (or it's the first snapshot)
    const hasChanged = !lastSnapshot ||
      lastSnapshot.likes !== likes ||
      lastSnapshot.hearts !== hearts ||
      lastSnapshot.laughs !== laughs ||
      lastSnapshot.cries !== cries ||
      lastSnapshot.comments !== comments;

    if (hasChanged) {
      if (!lastSnapshot) {
        // First snapshot — store absolute
        snapshots.push({ timestamp, likes, hearts, laughs, cries, comments });
      } else {
        // Subsequent snapshot — store as delta
        const delta = { timestamp };
        if (likes - lastSnapshot.likes) delta.dl = likes - lastSnapshot.likes;
        if (hearts - lastSnapshot.hearts) delta.dh = hearts - lastSnapshot.hearts;
        if (laughs - lastSnapshot.laughs) delta.dla = laughs - lastSnapshot.laughs;
        if (cries - lastSnapshot.cries) delta.dc = cries - lastSnapshot.cries;
        if (comments - lastSnapshot.comments) delta.dco = comments - lastSnapshot.comments;
        if (Object.keys(delta).length > 1) {
          snapshots.push(delta);
        }
      }
    }

    // Apply retention: resolve to absolute first, retain, then re-encode as deltas
    let resolvedSnapshots = resolveAllSnapshots(snapshots);
    resolvedSnapshots = applyRetentionPolicy(resolvedSnapshots);
    snapshots = encodeAsDeltas(resolvedSnapshots);

    return {
      id: String(img.id),
      name: img.meta?.prompt?.substring(0, 100) || `Image ${img.id}`,
      url: `https://civitai.com/images/${img.id}`,
      thumbnailUrl: img.url,
      createdAt: img.createdAt,
      snapshots
    };
  });

  const newImages = images.filter(img => img.snapshots.length === 1).length;
  const multiSnapshot = images.filter(img => img.snapshots.length > 1).length;
  console.log(`\nImage history: ${newImages} new, ${multiSnapshot} with prior history`);

  const totalSnapshot = {
    timestamp,
    likes: totalLikes,
    hearts: totalHearts,
    laughs: totalLaughs,
    cries: totalCries,
    comments: totalComments,
    imageCount: images.length
  };

  return { images, totalSnapshot };
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
    // Fetch all user images from Civitai
    const apiImages = await fetchAllUserImages(CIVITAI_USERNAME);

    if (apiImages.length === 0) {
      console.log('No images found for user. Exiting.');
      return;
    }

    // Read existing Gist data
    const existingData = await readGistData();

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

    // Process images with existing data to merge snapshots
    const { images, totalSnapshot } = processImages(apiImages, existingData.images);

    console.log('\nSnapshot created:');
    console.log(`  Images: ${totalSnapshot.imageCount}`);
    console.log(`  Likes: ${totalSnapshot.likes}`);
    console.log(`  Hearts: ${totalSnapshot.hearts}`);
    console.log(`  Laughs: ${totalSnapshot.laughs}`);
    console.log(`  Cries: ${totalSnapshot.cries}`);
    console.log(`  Comments: ${totalSnapshot.comments}`);

    // Append new total snapshot (as delta if possible)
    if (existingData.totalSnapshots.length > 0) {
      const prevTotal = resolveSnapshot(existingData.totalSnapshots, existingData.totalSnapshots.length - 1);
      const delta = { timestamp: totalSnapshot.timestamp, imageCount: totalSnapshot.imageCount };
      if (totalSnapshot.likes - prevTotal.likes) delta.dl = totalSnapshot.likes - prevTotal.likes;
      if (totalSnapshot.hearts - prevTotal.hearts) delta.dh = totalSnapshot.hearts - prevTotal.hearts;
      if (totalSnapshot.laughs - prevTotal.laughs) delta.dla = totalSnapshot.laughs - prevTotal.laughs;
      if (totalSnapshot.cries - prevTotal.cries) delta.dc = totalSnapshot.cries - prevTotal.cries;
      if (totalSnapshot.comments - prevTotal.comments) delta.dco = totalSnapshot.comments - prevTotal.comments;
      if (!delta.dl && !delta.dh && !delta.dla && !delta.dc && !delta.dco) {
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

    // SAFETY CHECK: Prevent catastrophic data loss
    // If we read existing data but new data has way fewer snapshots, something went wrong
    if (snapshotsBefore > 1) { // Only check if we had meaningful existing data
      const newImageSnapshotCount = images.reduce((sum, img) => {
        return sum + (img.snapshots?.length || 0);
      }, 0);

      // For validation, we need to count what we started with
      // We can estimate: if we had X totalSnapshots and Y images, we should have roughly similar image snapshots
      // A more precise check: count current vs what we expect after adding one more snapshot per image
      const expectedMinImageSnapshots = existingData.images.length; // At minimum, each image should have 1 snapshot

      console.log('\nData integrity check:');
      console.log(`  Total snapshots: ${existingData.totalSnapshots.length}`);
      console.log(`  Total image snapshots: ${newImageSnapshotCount}`);
      console.log(`  Images tracked: ${images.length}`);

      // Sanity check: We should have at least as many image snapshots as images
      // And the count should be reasonable (not drastically low)
      if (newImageSnapshotCount < expectedMinImageSnapshots) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════');
        console.error('DATA LOSS DETECTED!');
        console.error('═══════════════════════════════════════════════════════════');
        console.error(`Expected at least: ${expectedMinImageSnapshots} image snapshots`);
        console.error(`Actual image snapshots: ${newImageSnapshotCount}`);
        console.error('');
        console.error('This indicates a critical bug in data merging.');
        console.error('ABORTING to prevent overwriting good data with incomplete data.');
        console.error('═══════════════════════════════════════════════════════════');
        console.error('');
        process.exit(1);
      }

      console.log('✓ Data integrity check: PASSED');
    } else {
      console.log('\nSkipping data integrity check (first run or minimal existing data)');
    }

    // Update Gist
    await updateGist(existingData);

    console.log('\n=== Complete ===');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
