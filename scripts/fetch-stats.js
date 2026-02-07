import { Octokit } from '@octokit/rest';

// Environment variables
const GIST_ID = process.env.GIST_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;
const CIVITAI_USERNAME = process.env.CIVITAI_USERNAME;

// Validate required environment variables
if (!GIST_ID || !GIST_TOKEN || !CIVITAI_USERNAME) {
  console.error('Missing required environment variables:');
  if (!GIST_ID) console.error('  - GIST_ID');
  if (!GIST_TOKEN) console.error('  - GIST_TOKEN');
  if (!CIVITAI_USERNAME) console.error('  - CIVITAI_USERNAME');
  process.exit(1);
}

const octokit = new Octokit({ auth: GIST_TOKEN });

// Constants
const CIVITAI_API_BASE = 'https://civitai.com/api/v1';
const IMAGES_PER_PAGE = 200;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

// Data retention thresholds
const HOURLY_RETENTION_DAYS = 7;
const SIX_HOUR_RETENTION_DAYS = 30;

/**
 * Fetch with exponential backoff retry
 */
async function fetchWithRetry(url, retries = MAX_RETRIES, backoff = INITIAL_BACKOFF_MS) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);

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
 * Fetch all images for a user, paginating through all results
 */
async function fetchAllUserImages(username) {
  const allImages = [];
  let nextPage = `${CIVITAI_API_BASE}/images?username=${encodeURIComponent(username)}&limit=${IMAGES_PER_PAGE}&sort=Newest`;
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

  console.log(`Total images fetched: ${allImages.length}`);
  return allImages;
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
 */
function processImages(apiImages) {
  const timestamp = new Date().toISOString();

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

    return {
      id: String(img.id),
      name: img.meta?.prompt?.substring(0, 100) || `Image ${img.id}`,
      url: `https://civitai.com/images/${img.id}`,
      thumbnailUrl: img.url,
      createdAt: img.createdAt,
      currentStats: {
        likes,
        hearts,
        laughs,
        cries,
        comments
      }
    };
  });

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

  try {
    // Fetch all user images from Civitai
    const apiImages = await fetchAllUserImages(CIVITAI_USERNAME);

    if (apiImages.length === 0) {
      console.log('No images found for user. Exiting.');
      return;
    }

    // Process images and create snapshot
    const { images, totalSnapshot } = processImages(apiImages);

    console.log('\nSnapshot created:');
    console.log(`  Images: ${totalSnapshot.imageCount}`);
    console.log(`  Likes: ${totalSnapshot.likes}`);
    console.log(`  Hearts: ${totalSnapshot.hearts}`);
    console.log(`  Laughs: ${totalSnapshot.laughs}`);
    console.log(`  Cries: ${totalSnapshot.cries}`);
    console.log(`  Comments: ${totalSnapshot.comments}`);

    // Read existing Gist data
    const existingData = await readGistData();

    // Append new snapshot
    existingData.totalSnapshots.push(totalSnapshot);

    // Apply retention policy
    const snapshotsBefore = existingData.totalSnapshots.length;
    existingData.totalSnapshots = applyRetentionPolicy(existingData.totalSnapshots);
    const snapshotsAfter = existingData.totalSnapshots.length;

    if (snapshotsBefore !== snapshotsAfter) {
      console.log(`\nRetention policy: ${snapshotsBefore} -> ${snapshotsAfter} snapshots`);
    }

    // Update images with current stats
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
