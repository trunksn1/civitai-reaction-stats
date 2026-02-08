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
        const oldTotal = (batch[j].stats?.likeCount || 0) + (batch[j].stats?.heartCount || 0) +
                         (batch[j].stats?.laughCount || 0) + (batch[j].stats?.cryCount || 0);
        batch[j].stats = stats;
        const newTotal = (stats.likeCount || 0) + (stats.heartCount || 0) +
                         (stats.laughCount || 0) + (stats.cryCount || 0);
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
 * Fetch all images for a user, paginating through all results
 */
async function fetchAllUserImages(username) {
  const allImages = [];
  // Use period=AllTime to ensure we get all historical images
  let nextPage = `${CIVITAI_API_BASE}/images?username=${encodeURIComponent(username)}&limit=${IMAGES_PER_PAGE}&sort=Newest&period=AllTime`;
  let pageCount = 0;

  console.log(`Fetching images for user: ${username}`);

  while (nextPage) {
    pageCount++;
    console.log(`Fetching page ${pageCount}...`);

    const data = await fetchWithRetry(nextPage);

    if (data.items && data.items.length > 0) {
      allImages.push(...data.items);
      console.log(`  Retrieved ${data.items.length} images (total: ${allImages.length})`);
    }

    nextPage = data.metadata?.nextPage || null;

    // Small delay between pages to be respectful
    if (nextPage) {
      await sleep(500);
    }
  }

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
 * Read existing Gist data
 */
async function readGistData() {
  try {
    const gist = await octokit.gists.get({ gist_id: GIST_ID });
    const content = gist.data.files['stats.json']?.content;

    if (!content || content.trim() === '{}' || content.trim() === '') {
      return createEmptyStats();
    }

    return JSON.parse(content);
  } catch (error) {
    console.log('Could not read existing Gist, starting fresh:', error.message);
    return createEmptyStats();
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
  const content = JSON.stringify(data, null, 2);

  await octokit.gists.update({
    gist_id: GIST_ID,
    files: {
      'stats.json': {
        content: content
      }
    }
  });

  console.log('Gist updated successfully');
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
    const likes = img.stats?.likeCount || 0;
    const hearts = img.stats?.heartCount || 0;
    const laughs = img.stats?.laughCount || 0;
    const cries = img.stats?.cryCount || 0;
    const comments = img.stats?.commentCount || 0;

    totalLikes += likes;
    totalHearts += hearts;
    totalLaughs += laughs;
    totalCries += cries;
    totalComments += comments;

    // Create new snapshot for this image
    const newSnapshot = {
      timestamp,
      likes,
      hearts,
      laughs,
      cries,
      comments
    };

    // Get existing image data if available
    const existingImage = existingImageMap.get(String(img.id));

    // Merge with existing snapshots
    let snapshots = existingImage?.snapshots || [];
    snapshots.push(newSnapshot);

    // Apply same retention policy as totalSnapshots
    snapshots = applyRetentionPolicy(snapshots);

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

    // Append new snapshot
    existingData.totalSnapshots.push(totalSnapshot);

    // Apply retention policy to total snapshots
    const snapshotsBefore = existingData.totalSnapshots.length;
    existingData.totalSnapshots = applyRetentionPolicy(existingData.totalSnapshots);
    const snapshotsAfter = existingData.totalSnapshots.length;

    if (snapshotsBefore !== snapshotsAfter) {
      console.log(`\nRetention policy (total): ${snapshotsBefore} -> ${snapshotsAfter} snapshots`);
    }

    // Update images with merged snapshots
    existingData.images = images;
    existingData.username = CIVITAI_USERNAME;
    existingData.lastUpdated = totalSnapshot.timestamp;

    // Update Gist
    await updateGist(existingData);

    console.log('\n=== Complete ===');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
