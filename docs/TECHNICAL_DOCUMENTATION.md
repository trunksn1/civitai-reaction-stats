# Technical Documentation: Civitai Reaction Stats

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Data Collection Pipeline](#data-collection-pipeline)
4. [Tiered Refresh Strategy](#tiered-refresh-strategy)
5. [Data Structures](#data-structures)
6. [API Integration](#api-integration)
7. [Data Retention & Aggregation](#data-retention--aggregation)
8. [Chrome Extension](#chrome-extension)
9. [Error Handling & Resilience](#error-handling--resilience)
10. [Performance Considerations](#performance-considerations)

---

## System Overview

**Purpose:** Automatically track and visualize reaction statistics (likes, hearts, laughs, cries, comments) for Civitai images over time.

**Core Problem Solved:**
- Civitai's bulk API returns **stale/cached statistics** that can be hours or days old
- No built-in historical tracking - you only see current stats
- No way to track growth trends or see when reactions occurred

**Solution Components:**
1. **GitHub Actions Cron Job** - Runs hourly to collect fresh stats
2. **Smart Refresh Logic** - Tiered system to minimize API calls while keeping data fresh
3. **GitHub Gist Storage** - Free, version-controlled JSON storage
4. **Chrome Extension** - Beautiful UI with charts injected into Civitai's website

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GITHUB ACTIONS (Hourly)                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  1. Trigger: Cron Schedule (every hour) OR Manual Dispatch │    │
│  │  2. Environment: Ubuntu Latest + Node.js 20                │    │
│  │  3. Secrets: GIST_ID, GIST_TOKEN, CIVITAI_USERNAME,        │    │
│  │              CIVITAI_API_KEY (optional)                     │    │
│  └────────────────────────────────────────────────────────────┘    │
│                              ↓                                       │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │            scripts/fetch-stats.js (Node.js)                │    │
│  │  ┌──────────────────────────────────────────────────────┐  │    │
│  │  │ Step 1: Determine Refresh Tier                       │  │    │
│  │  │   • Check REFRESH_TIER env var (manual override)     │  │    │
│  │  │   • Or use date-based logic (auto)                   │  │    │
│  │  └──────────────────────────────────────────────────────┘  │    │
│  │  ┌──────────────────────────────────────────────────────┐  │    │
│  │  │ Step 2: Fetch User Images (Bulk)                    │  │    │
│  │  │   • Civitai API: /images?username=X&period=AllTime  │  │    │
│  │  │   • Pagination: retrieve ALL pages                   │  │    │
│  │  │   • Filter: remove unpublished (future dates)        │  │    │
│  │  │   • Result: Array of images with STALE stats         │  │    │
│  │  └──────────────────────────────────────────────────────┘  │    │
│  │  ┌──────────────────────────────────────────────────────┐  │    │
│  │  │ Step 3: Refresh Individual Stats (Smart)            │  │    │
│  │  │   • Select images based on refresh tier:             │  │    │
│  │  │     - Daily: last 30 days + 0 stats                  │  │    │
│  │  │     - Monthly: last 6 months + 0 stats               │  │    │
│  │  │     - Quarterly: ALL images                          │  │    │
│  │  │   • Re-fetch: /images?imageId=X (accurate!)         │  │    │
│  │  │   • Batch: 5 concurrent, 300ms delay between         │  │    │
│  │  │   • Result: Fresh stats for selected images          │  │    │
│  │  └──────────────────────────────────────────────────────┘  │    │
│  │  ┌──────────────────────────────────────────────────────┐  │    │
│  │  │ Step 4: Read Existing Gist Data                      │  │    │
│  │  │   • Octokit API: GET /gists/{gist_id}               │  │    │
│  │  │   • Parse: stats.json content                        │  │    │
│  │  │   • Extract: existing snapshots for each image       │  │    │
│  │  └──────────────────────────────────────────────────────┘  │    │
│  │  ┌──────────────────────────────────────────────────────┐  │    │
│  │  │ Step 5: Merge & Process Data                         │  │    │
│  │  │   • Create new snapshot with current timestamp       │  │    │
│  │  │   • Append to existing image snapshots               │  │    │
│  │  │   • Calculate aggregate totals                       │  │    │
│  │  │   • Apply retention policy (aggregate old data)      │  │    │
│  │  └──────────────────────────────────────────────────────┘  │    │
│  │  ┌──────────────────────────────────────────────────────┐  │    │
│  │  │ Step 6: Update Gist                                  │  │    │
│  │  │   • Octokit API: PATCH /gists/{gist_id}             │  │    │
│  │  │   • Write: Updated stats.json (prettified)           │  │    │
│  │  │   • Result: Persistent, version-controlled storage   │  │    │
│  │  └──────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│                    GITHUB GIST (Public Storage)                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  stats.json (Time-Series JSON Data)                        │    │
│  │  • username                                                 │    │
│  │  • lastUpdated                                              │    │
│  │  • totalSnapshots[] - Aggregate stats over time            │    │
│  │  • images[] - Individual image data with snapshots[]       │    │
│  └────────────────────────────────────────────────────────────┘    │
│           Available at: gist.githubusercontent.com/.../raw/         │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│                    CHROME EXTENSION (Client-Side)                   │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Service Worker (Background)                               │    │
│  │  • Fetches stats.json from Gist URL                        │    │
│  │  • Handles cross-origin requests                           │    │
│  │  • Stores Gist URL in chrome.storage                       │    │
│  └────────────────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Content Script (civitai.com injection)                    │    │
│  │  • Detects user dropdown menu                              │    │
│  │  • Injects "Stats" menu item                               │    │
│  │  • Opens stats page on click                               │    │
│  └────────────────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Stats Page (Visualization)                                │    │
│  │  • Renders with Chart.js (bundled)                         │    │
│  │  • Time range selectors: 1d, 7d, 30d, 90d, All            │    │
│  │  • Summary cards with delta calculations                   │    │
│  │  • Per-image table with sorting                            │    │
│  │  • Dark theme matching Civitai                             │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Collection Pipeline

### 1. Workflow Trigger

**File:** `.github/workflows/collect-stats.yml`

**Trigger Methods:**
```yaml
on:
  schedule:
    - cron: '0 * * * *'  # Every hour at :00
  workflow_dispatch:      # Manual trigger via GitHub UI
    inputs:
      refresh-tier:
        type: choice
        options: [auto, daily, monthly, quarterly]
```

**Environment Variables Passed to Script:**
- `GIST_ID` - Target Gist identifier
- `GIST_TOKEN` - GitHub Personal Access Token with Gist write permissions
- `CIVITAI_USERNAME` - Civitai username to track
- `CIVITAI_API_KEY` - (Optional) For authenticated Civitai API requests
- `REFRESH_TIER` - (Optional) Manual override: 'auto', 'daily', 'monthly', 'quarterly'

### 2. Bulk Image Fetch

**Function:** `fetchAllUserImages(username)`

**Purpose:** Get all images for the user (with pagination)

**API Endpoint:**
```
GET https://civitai.com/api/v1/images?username={username}&limit=200&sort=Newest&period=AllTime
```

**Key Parameters:**
- `period=AllTime` - Ensures historical images are included (not just recent)
- `limit=200` - Maximum page size for efficiency
- `sort=Newest` - Consistent ordering

**Pagination Logic:**
```javascript
let nextPage = initialUrl;
while (nextPage) {
  const data = await fetchWithRetry(nextPage);
  allImages.push(...data.items);
  nextPage = data.metadata?.nextPage || null;
}
```

**Filtering:**
- Remove images with `createdAt` in the future (scheduled/unpublished)
- These haven't been published yet so stats would be meaningless

**Result:** Array of all published images with **stale stats**

### 3. Tiered Stat Refresh

**Function:** `refreshImageStats(images)`

**Problem:** Bulk API returns cached stats (can be hours/days old)

**Solution:** Re-fetch individual images, but smartly based on age

**Selection Logic:**
```javascript
function getRefreshTier() {
  // Check manual override first
  if (REFRESH_TIER_OVERRIDE && REFRESH_TIER_OVERRIDE !== 'auto') {
    return REFRESH_TIER_OVERRIDE; // 'daily', 'monthly', or 'quarterly'
  }

  // Auto: date-based logic
  const dayOfMonth = new Date().getDate();
  const month = new Date().getMonth(); // 0-indexed

  if (dayOfMonth === 1 && month % 3 === 0) return 'quarterly'; // Jan 1, Apr 1, Jul 1, Oct 1
  if (dayOfMonth === 1) return 'monthly'; // 1st of any month
  return 'daily'; // Default
}
```

**Refresh Rules:**

| Tier | Images Refreshed | Reasoning |
|------|------------------|-----------|
| **Daily** | • Last 30 days<br>• Any with 0 total stats | Recent images change frequently |
| **Monthly** | • Last 6 months<br>• Any with 0 total stats | Medium-age images still active |
| **Quarterly** | • ALL images | Complete refresh, even ancient images |

**Individual Fetch:**
```javascript
async function fetchImageStats(imageId) {
  const url = `${CIVITAI_API_BASE}/images?imageId=${imageId}`;
  const data = await fetchWithRetry(url);
  return data.items[0].stats; // FRESH stats!
}
```

**Batching:**
- Process in batches of 5 concurrent requests
- 300ms delay between batches
- Prevents overwhelming Civitai API
- Rate limit handling in `fetchWithRetry()`

**Progress Tracking:**
```javascript
// Log every 50 images
if (processed % 50 === 0) {
  console.log(`Progress: ${processed}/${total} (${updated} changed)`);
}
```

### 4. Data Merging

**Function:** `processImages(apiImages, existingImages)`

**Steps:**

1. **Create lookup map:**
   ```javascript
   const existingImageMap = new Map(existingImages.map(img => [img.id, img]));
   ```

2. **For each image:**
   ```javascript
   const newSnapshot = {
     timestamp: new Date().toISOString(),
     likes: img.stats?.likeCount || 0,
     hearts: img.stats?.heartCount || 0,
     laughs: img.stats?.laughCount || 0,
     cries: img.stats?.cryCount || 0,
     comments: img.stats?.commentCount || 0
   };
   ```

3. **Merge with existing snapshots:**
   ```javascript
   const existingImage = existingImageMap.get(String(img.id));
   let snapshots = existingImage?.snapshots || [];
   snapshots.push(newSnapshot);
   ```

4. **Apply retention policy:**
   ```javascript
   snapshots = applyRetentionPolicy(snapshots);
   ```

5. **Build image object:**
   ```javascript
   {
     id: String(img.id),
     name: img.meta?.prompt?.substring(0, 100) || `Image ${img.id}`,
     url: `https://civitai.com/images/${img.id}`,
     thumbnailUrl: img.url,
     createdAt: img.createdAt,
     snapshots: snapshots // Time-series array
   }
   ```

6. **Calculate aggregate totals:**
   ```javascript
   const totalSnapshot = {
     timestamp: timestamp,
     likes: sum(allImages.likes),
     hearts: sum(allImages.hearts),
     laughs: sum(allImages.laughs),
     cries: sum(allImages.cries),
     comments: sum(allImages.comments),
     imageCount: images.length
   };
   ```

### 5. Gist Update

**Function:** `updateGist(data)`

**API Call:**
```javascript
await octokit.gists.update({
  gist_id: GIST_ID,
  files: {
    'stats.json': {
      content: JSON.stringify(data, null, 2) // Pretty-printed
    }
  }
});
```

**Result:**
- Data persisted to GitHub Gist
- Version-controlled (can see history)
- Publicly accessible via raw URL
- Free hosting

---

## Tiered Refresh Strategy

### Why Tiered Refresh?

**Challenge:**
- Civitai bulk API: Fast but returns **stale stats** (cached)
- Individual image API: Accurate but **expensive** (rate limits)
- User has hundreds of images
- Want fresh stats without hitting rate limits

**Solution:** Refresh based on age and activity

### Tier Selection Algorithm

```javascript
function shouldRefreshImage(image, tier) {
  const now = new Date();
  const createdAt = new Date(image.createdAt);
  const age = now - createdAt;

  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const sixMonths = 180 * 24 * 60 * 60 * 1000;

  const totalStats = (image.stats?.likeCount || 0) +
                     (image.stats?.heartCount || 0) +
                     (image.stats?.laughCount || 0) +
                     (image.stats?.cryCount || 0);

  // Always refresh images with 0 stats (might be gaining traction)
  if (totalStats === 0) return true;

  // Daily tier: last 30 days
  if (age <= thirtyDays) return true;

  // Monthly tier: last 6 months
  if (tier === 'monthly' && age <= sixMonths) return true;
  if (tier === 'quarterly' && age <= sixMonths) return true;

  // Quarterly tier: ALL images
  if (tier === 'quarterly') return true;

  return false;
}
```

### Example Scenario

**User has 500 images:**
- 50 images in last 30 days
- 100 images in 31 days - 6 months
- 350 images older than 6 months

**Hourly Run (Daily Tier):**
- Refreshes: 50 recent images + any with 0 stats
- API calls: ~50-60
- Time: ~3-5 minutes

**Monthly Run (1st of Month):**
- Refreshes: 150 images (last 6 months) + any with 0 stats
- API calls: ~150-160
- Time: ~8-10 minutes

**Quarterly Run (Jan 1, Apr 1, Jul 1, Oct 1):**
- Refreshes: ALL 500 images
- API calls: ~500
- Time: ~25-30 minutes

### Manual Override

**Use Case:** User wants to force refresh old images immediately

**How:**
1. GitHub → Actions → Collect Civitai Stats
2. Click "Run workflow"
3. Select "quarterly" from dropdown
4. Click "Run workflow"

**Implementation:**
```javascript
// In fetch-stats.js
const REFRESH_TIER_OVERRIDE = process.env.REFRESH_TIER;

function getRefreshTier() {
  if (REFRESH_TIER_OVERRIDE && REFRESH_TIER_OVERRIDE !== 'auto') {
    console.log(`Using manual refresh tier override: ${REFRESH_TIER_OVERRIDE}`);
    return REFRESH_TIER_OVERRIDE;
  }
  // ... date-based logic
}
```

---

## Data Structures

### Gist JSON Schema

```typescript
interface StatsData {
  username: string;                    // Civitai username
  lastUpdated: string;                 // ISO 8601 timestamp
  totalSnapshots: TotalSnapshot[];     // Aggregate stats over time
  images: ImageData[];                 // Individual image data
}

interface TotalSnapshot {
  timestamp: string;                   // ISO 8601 timestamp
  likes: number;                       // Sum of all image likes
  hearts: number;                      // Sum of all image hearts
  laughs: number;                      // Sum of all image laughs
  cries: number;                       // Sum of all image cries
  comments: number;                    // Sum of all image comments
  imageCount: number;                  // Total number of images
}

interface ImageData {
  id: string;                          // Civitai image ID
  name: string;                        // Truncated prompt (first 100 chars)
  url: string;                         // https://civitai.com/images/{id}
  thumbnailUrl: string;                // Direct image URL
  createdAt: string;                   // ISO 8601 timestamp
  snapshots: ImageSnapshot[];          // Time-series stats for this image
}

interface ImageSnapshot {
  timestamp: string;                   // ISO 8601 timestamp
  likes: number;                       // Reaction counts at this time
  hearts: number;
  laughs: number;
  cries: number;
  comments: number;
}
```

### Example Real Data

```json
{
  "username": "MyUsername",
  "lastUpdated": "2024-01-15T10:00:00.000Z",
  "totalSnapshots": [
    {
      "timestamp": "2024-01-15T08:00:00.000Z",
      "likes": 1450,
      "hearts": 780,
      "laughs": 385,
      "cries": 195,
      "comments": 142,
      "imageCount": 48
    },
    {
      "timestamp": "2024-01-15T09:00:00.000Z",
      "likes": 1480,
      "hearts": 795,
      "laughs": 398,
      "cries": 199,
      "comments": 148,
      "imageCount": 50
    },
    {
      "timestamp": "2024-01-15T10:00:00.000Z",
      "likes": 1500,
      "hearts": 800,
      "laughs": 400,
      "cries": 200,
      "comments": 150,
      "imageCount": 50
    }
  ],
  "images": [
    {
      "id": "12345678",
      "name": "A beautiful landscape with mountains and a lake at sunset, highly detailed, 8k",
      "url": "https://civitai.com/images/12345678",
      "thumbnailUrl": "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/abcd1234/width=450/12345678.jpeg",
      "createdAt": "2024-01-14T12:30:00.000Z",
      "snapshots": [
        {
          "timestamp": "2024-01-15T08:00:00.000Z",
          "likes": 95,
          "hearts": 48,
          "laughs": 28,
          "cries": 10,
          "comments": 22
        },
        {
          "timestamp": "2024-01-15T09:00:00.000Z",
          "likes": 98,
          "hearts": 49,
          "laughs": 29,
          "cries": 10,
          "comments": 24
        },
        {
          "timestamp": "2024-01-15T10:00:00.000Z",
          "likes": 100,
          "hearts": 50,
          "laughs": 30,
          "cries": 10,
          "comments": 25
        }
      ]
    }
  ]
}
```

---

## API Integration

### Civitai API Endpoints

#### 1. Bulk Image Fetch
```
GET https://civitai.com/api/v1/images
```

**Query Parameters:**
- `username` - Filter by username (required)
- `limit` - Results per page (max 200)
- `sort` - Sort order (Newest, Oldest, Most Reactions, etc.)
- `period` - Time period (AllTime to get historical)
- `page` - Page number (or use nextPage from metadata)

**Response:**
```json
{
  "items": [
    {
      "id": 12345678,
      "url": "https://image.civitai.com/.../image.jpeg",
      "hash": "...",
      "width": 1024,
      "height": 1024,
      "nsfw": false,
      "createdAt": "2024-01-14T12:30:00.000Z",
      "postId": 98765,
      "stats": {
        "cryCount": 10,
        "laughCount": 30,
        "likeCount": 100,
        "heartCount": 50,
        "commentCount": 25
      },
      "meta": {
        "prompt": "A beautiful landscape...",
        "Model": "someModel_v1.safetensors",
        "sampler": "DPM++ 2M Karras",
        "steps": 30
      }
    }
  ],
  "metadata": {
    "nextPage": "https://civitai.com/api/v1/images?username=X&page=2",
    "currentPage": 1,
    "pageSize": 200,
    "totalPages": 3,
    "totalItems": 500
  }
}
```

**Issue:** `stats` field contains **cached/stale data** (can be hours or days old)

#### 2. Individual Image Fetch (Accurate Stats)
```
GET https://civitai.com/api/v1/images?imageId={imageId}
```

**Query Parameters:**
- `imageId` - Single image ID

**Response:** Same structure as bulk, but `items` array has only 1 item

**Key Difference:** Stats are **fresh/real-time** when querying by imageId

**Why?** Civitai's backend behavior:
- Bulk queries: Return cached aggregated data (performance)
- Single image query: Fetch live stats from database (accuracy)

### GitHub Gist API (via Octokit)

#### Read Gist
```javascript
const gist = await octokit.gists.get({
  gist_id: GIST_ID
});
const content = gist.data.files['stats.json']?.content;
const data = JSON.parse(content);
```

#### Update Gist
```javascript
await octokit.gists.update({
  gist_id: GIST_ID,
  files: {
    'stats.json': {
      content: JSON.stringify(data, null, 2)
    }
  }
});
```

**Authentication:** Requires Personal Access Token with Gist read/write permission

### API Rate Limiting

**Civitai API:**
- Unauthenticated: ~60 requests/minute
- Authenticated (with API key): ~120 requests/minute
- Rate limit header: `Retry-After` (seconds to wait)

**GitHub API:**
- Authenticated: 5000 requests/hour
- Gist operations count as 1 request each
- Not a concern for this use case (only 2 Gist API calls per run)

---

## Data Retention & Aggregation

### Problem

Without aggregation, data grows exponentially:
- Hourly snapshots: 24/day, 168/week, 8760/year
- 100 images × 8760 snapshots = 876,000 data points per year
- Gist size would become massive and slow to process

### Solution: Time-Based Aggregation

**Function:** `applyRetentionPolicy(snapshots)`

**Strategy:** Keep granular data for recent periods, aggregate older data

```javascript
function applyRetentionPolicy(snapshots) {
  const now = Date.now();
  const hourlyThreshold = now - (7 * 24 * 60 * 60 * 1000);    // 7 days ago
  const sixHourThreshold = now - (30 * 24 * 60 * 60 * 1000);  // 30 days ago

  const hourlySnapshots = [];    // Last 7 days
  const sixHourSnapshots = [];   // 7-30 days ago
  const dailySnapshots = [];     // 30+ days ago

  for (const snapshot of snapshots) {
    const timestamp = new Date(snapshot.timestamp).getTime();

    if (timestamp >= hourlyThreshold) {
      hourlySnapshots.push(snapshot);
    } else if (timestamp >= sixHourThreshold) {
      sixHourSnapshots.push(snapshot);
    } else {
      dailySnapshots.push(snapshot);
    }
  }

  // Aggregate older data
  const aggregatedSixHour = aggregateSnapshots(sixHourSnapshots, 6);   // 6-hour buckets
  const aggregatedDaily = aggregateSnapshots(dailySnapshots, 24);      // 24-hour buckets

  // Combine and sort
  return [...aggregatedDaily, ...aggregatedSixHour, ...hourlySnapshots]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}
```

### Aggregation Algorithm

**Function:** `aggregateSnapshots(snapshots, intervalHours)`

**Logic:** Group snapshots into time buckets, keep the **last** snapshot in each bucket

```javascript
function aggregateSnapshots(snapshots, intervalHours) {
  if (snapshots.length === 0) return [];

  const intervalMs = intervalHours * 60 * 60 * 1000;
  const aggregated = [];
  let currentBucket = null;
  let currentBucketStart = null;

  for (const snapshot of snapshots) {
    const timestamp = new Date(snapshot.timestamp).getTime();
    // Calculate which bucket this snapshot belongs to
    const bucketStart = Math.floor(timestamp / intervalMs) * intervalMs;

    if (currentBucketStart !== bucketStart) {
      // New bucket - save previous bucket's last value
      if (currentBucket) {
        aggregated.push(currentBucket);
      }
      currentBucketStart = bucketStart;
    }

    // Always overwrite - we want the LAST snapshot in the bucket
    currentBucket = snapshot;
  }

  // Don't forget the last bucket
  if (currentBucket) {
    aggregated.push(currentBucket);
  }

  return aggregated;
}
```

**Why keep the last value?**
- Represents the end-of-period state
- Most accurate for trend visualization
- Consistent with time-series best practices

### Example: 7 Days of Hourly Data → 30 Days Later

**Initial (Day 1-7):** 168 hourly snapshots

**After 30 days:**
- Day 1-7 data is now 23-30 days old
- Falls into "6-hour aggregation" bucket
- 168 snapshots → 28 snapshots (168 / 6 = 28)
- **83% data reduction** while preserving trends

**After 1 year:**
- Day 1-7 data is now 358-365 days old
- Falls into "daily aggregation" bucket
- 168 snapshots → 7 snapshots (1 per day)
- **96% data reduction**

### Retention Timeline Visualization

```
Timeline:  [----7 days----][--------23 days--------][----------Forever----------]
           (Hourly=168)    (6-hour=92)              (Daily=∞)

Day 0:     [H H H H H H H]
Day 30:                    [6 6 6 6 6 6 6][H H H H H H H]
Day 60:                                    [D D D D D D D][6 6 6 6 6 6 6][H H H H H H H]
Day 365:   [D D D D...355 daily snapshots..D][6 6 6 6 6 6 6][H H H H H H H]
```

**Result:** Data grows logarithmically instead of linearly

---

## Chrome Extension

### Architecture

**Manifest V3** (latest Chrome extension standard)

**Components:**
1. **Service Worker** - Background script (event-driven)
2. **Content Script** - Injected into civitai.com pages
3. **Popup** - Settings UI (Gist URL configuration)
4. **Stats Page** - Full-page visualization with charts

### Service Worker (service-worker.js)

**Purpose:**
- Handle cross-origin data fetching (CORS bypass)
- Store user configuration (Gist URL)
- Message passing between components

**Key Functions:**

```javascript
// Listen for messages from content script or stats page
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchStats') {
    fetchStatsFromGist().then(sendResponse);
    return true; // Async response
  }
  if (request.action === 'getGistUrl') {
    chrome.storage.sync.get(['gistUrl'], (result) => {
      sendResponse({ gistUrl: result.gistUrl });
    });
    return true;
  }
});

// Fetch stats from configured Gist URL
async function fetchStatsFromGist() {
  const { gistUrl } = await chrome.storage.sync.get(['gistUrl']);
  if (!gistUrl) return { error: 'Not configured' };

  const response = await fetch(gistUrl);
  if (!response.ok) return { error: `HTTP ${response.status}` };

  const data = await response.json();
  return { data };
}
```

**Why Service Worker?**
- Content scripts can't make cross-origin requests (CORS)
- Service worker has elevated permissions (declared in manifest)
- Persistent configuration storage

### Content Script (content/content-script.js)

**Purpose:** Inject "Stats" menu item into Civitai's user dropdown

**Injection Strategy:**

```javascript
function injectStatsMenuItem() {
  // Wait for Civitai's user menu to load
  const userMenu = document.querySelector('[data-menu="user-menu"]');
  if (!userMenu) {
    setTimeout(injectStatsMenuItem, 500); // Retry
    return;
  }

  // Create menu item
  const statsItem = document.createElement('a');
  statsItem.href = '#';
  statsItem.textContent = '📊 Stats';
  statsItem.className = 'menu-item'; // Match Civitai's styling

  statsItem.addEventListener('click', (e) => {
    e.preventDefault();
    // Open stats page in new tab
    chrome.runtime.sendMessage({
      action: 'openStatsPage'
    });
  });

  // Insert into menu (after first item)
  const firstItem = userMenu.querySelector('.menu-item');
  userMenu.insertBefore(statsItem, firstItem.nextSibling);
}

// Run when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectStatsMenuItem);
} else {
  injectStatsMenuItem();
}
```

**Challenges:**
- Civitai uses client-side routing (React/Next.js)
- Menu might not exist on initial load
- Need to detect when user logs in

**Solution:** Polling with exponential backoff until menu found

### Stats Page (stats-page/stats.html + stats.js)

**Purpose:** Render charts and statistics

**UI Components:**

1. **Time Range Selector**
   ```html
   <div class="time-range-buttons">
     <button data-range="1d">1 Day</button>
     <button data-range="7d">7 Days</button>
     <button data-range="30d">30 Days</button>
     <button data-range="90d">90 Days</button>
     <button data-range="all" class="active">All Time</button>
   </div>
   ```

2. **Summary Cards**
   ```html
   <div class="summary-cards">
     <div class="card">
       <div class="emoji">👍</div>
       <div class="label">Likes</div>
       <div class="value">1,500</div>
       <div class="delta">+25 (7d)</div>
     </div>
     <!-- More cards for hearts, laughs, cries, comments -->
   </div>
   ```

3. **Chart Container**
   ```html
   <canvas id="reactionsChart"></canvas>
   ```

4. **Per-Image Table**
   ```html
   <table class="images-table">
     <thead>
       <tr>
         <th>Thumbnail</th>
         <th>Name</th>
         <th>Date</th>
         <th>Reactions</th>
         <th>Comments</th>
       </tr>
     </thead>
     <tbody id="imagesTableBody">
       <!-- Dynamically populated -->
     </tbody>
   </table>
   ```

**Chart Rendering (Chart.js):**

```javascript
function renderChart(timeRange) {
  const filteredSnapshots = filterByTimeRange(data.totalSnapshots, timeRange);

  const chartData = {
    labels: filteredSnapshots.map(s => new Date(s.timestamp)),
    datasets: [
      {
        label: '👍 Likes',
        data: filteredSnapshots.map(s => s.likes),
        borderColor: 'rgb(59, 130, 246)',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
      },
      {
        label: '❤️ Hearts',
        data: filteredSnapshots.map(s => s.hearts),
        borderColor: 'rgb(239, 68, 68)',
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
      },
      // ... more datasets
    ]
  };

  const config = {
    type: 'line',
    data: chartData,
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'hour' }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Count' }
        }
      }
    }
  };

  if (window.chartInstance) {
    window.chartInstance.destroy();
  }
  window.chartInstance = new Chart(
    document.getElementById('reactionsChart'),
    config
  );
}
```

**Delta Calculation:**

```javascript
function calculateDelta(snapshots, days) {
  if (snapshots.length < 2) return null;

  const now = Date.now();
  const cutoff = now - (days * 24 * 60 * 60 * 1000);

  const latest = snapshots[snapshots.length - 1];
  const baseline = snapshots.find(s =>
    new Date(s.timestamp).getTime() >= cutoff
  ) || snapshots[0];

  return {
    likes: latest.likes - baseline.likes,
    hearts: latest.hearts - baseline.hearts,
    laughs: latest.laughs - baseline.laughs,
    cries: latest.cries - baseline.cries,
    comments: latest.comments - baseline.comments
  };
}
```

### Popup (popup/popup.html + popup.js)

**Purpose:** Configure Gist URL

**UI:**
```html
<div class="popup-container">
  <h2>Civitai Reaction Stats</h2>
  <input
    type="text"
    id="gistUrl"
    placeholder="https://gist.githubusercontent.com/.../raw/stats.json"
  />
  <button id="saveBtn">Save</button>
  <div id="status"></div>
  <button id="openStatsBtn">Open Stats</button>
</div>
```

**Save Logic:**
```javascript
document.getElementById('saveBtn').addEventListener('click', () => {
  const gistUrl = document.getElementById('gistUrl').value.trim();

  if (!gistUrl.startsWith('https://gist.githubusercontent.com/')) {
    showStatus('Invalid URL', 'error');
    return;
  }

  chrome.storage.sync.set({ gistUrl }, () => {
    showStatus('Saved!', 'success');
  });
});
```

---

## Error Handling & Resilience

### Exponential Backoff Retry

**Function:** `fetchWithRetry(url, retries, backoff)`

**Purpose:** Handle transient network errors and rate limits

```javascript
async function fetchWithRetry(url, retries = 3, backoff = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers });

      // Handle rate limiting (HTTP 429)
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : backoff;
        console.log(`Rate limited. Waiting ${waitTime}ms before retry ${attempt}/${retries}`);
        await sleep(waitTime);
        backoff *= 2; // Exponential backoff
        continue;
      }

      // Handle other HTTP errors
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();

    } catch (error) {
      if (attempt === retries) {
        throw error; // Final attempt failed
      }
      console.log(`Attempt ${attempt} failed: ${error.message}. Retrying in ${backoff}ms...`);
      await sleep(backoff);
      backoff *= 2; // Double wait time each retry
    }
  }
}
```

**Retry Strategy:**
- Initial backoff: 1 second
- Exponential: 1s → 2s → 4s
- Max retries: 3
- Rate limit handling: Respect `Retry-After` header

### Graceful Degradation

**Scenario:** Some images fail to fetch

```javascript
async function fetchImageStats(imageId) {
  try {
    const data = await fetchWithRetry(url);
    return data.items[0].stats;
  } catch (error) {
    console.log(`Warning: Failed to fetch stats for image ${imageId}: ${error.message}`);
    return null; // Don't fail entire batch
  }
}

// In batch processing
for (let j = 0; j < batch.length; j++) {
  const stats = results[j];
  if (stats) {
    batch[j].stats = stats; // Update
  } else {
    // Keep old stats, don't update
    unchanged++;
  }
}
```

### Validation

**Environment Variables:**
```javascript
if (!GIST_ID || !GIST_TOKEN || !CIVITAI_USERNAME) {
  console.error('Missing required environment variables:');
  if (!GIST_ID) console.error('  - GIST_ID');
  if (!GIST_TOKEN) console.error('  - GIST_TOKEN');
  if (!CIVITAI_USERNAME) console.error('  - CIVITAI_USERNAME');
  process.exit(1);
}
```

**Gist Data:**
```javascript
async function readGistData() {
  try {
    const gist = await octokit.gists.get({ gist_id: GIST_ID });
    const content = gist.data.files['stats.json']?.content;

    if (!content || content.trim() === '{}' || content.trim() === '') {
      return createEmptyStats(); // Initialize
    }

    return JSON.parse(content);
  } catch (error) {
    console.log('Could not read existing Gist, starting fresh:', error.message);
    return createEmptyStats();
  }
}
```

### Logging

**Progress Tracking:**
```javascript
console.log(`Fetching page ${pageCount}...`);
console.log(`  Retrieved ${data.items.length} images (total: ${allImages.length})`);
console.log(`\nRefreshing stats: ${refreshList.length}/${images.length} images (tier: ${tier})`);
console.log(`  Progress: ${processed}/${refreshList.length} (${updated} changed)`);
```

**Summary:**
```javascript
console.log(`\nIndividual stats refresh complete:`);
console.log(`  Stats changed: ${updated}`);
console.log(`  Unchanged: ${unchanged}`);
```

---

## Performance Considerations

### API Call Optimization

**Problem:** Each image refresh = 1 API call. 500 images = 500 API calls

**Solutions:**

1. **Tiered Refresh**
   - Don't refresh old images every hour
   - Daily: ~50 API calls (recent images only)
   - Quarterly: ~500 API calls (all images)

2. **Batching**
   ```javascript
   const STATS_BATCH_SIZE = 5;
   for (let i = 0; i < refreshList.length; i += STATS_BATCH_SIZE) {
     const batch = refreshList.slice(i, i + STATS_BATCH_SIZE);
     const results = await Promise.all(batch.map(img => fetchImageStats(img.id)));
     // Process results...
     await sleep(300); // Delay between batches
   }
   ```
   - 5 concurrent requests (parallel)
   - 300ms delay between batches
   - Balance: Speed vs. rate limits

3. **Smart Selection**
   - Always refresh images with 0 stats (might be gaining traction)
   - Skip images that rarely change (old + stable)

### Gist Size Management

**Problem:** Gist can grow large, causing:
- Slow fetch times for extension
- Slow GitHub Actions runs
- Large diffs in version history

**Solutions:**

1. **Data Aggregation** (covered in retention section)
   - Hourly → 6-hour → daily
   - Keeps data size bounded

2. **Truncate Image Names**
   ```javascript
   name: img.meta?.prompt?.substring(0, 100) || `Image ${img.id}`
   ```
   - Prompts can be very long (1000+ chars)
   - 100 chars sufficient for identification

3. **Avoid Redundant Data**
   - Don't store `width`, `height`, `hash`, etc. (not needed for stats)
   - Only store: id, name, url, thumbnailUrl, createdAt, snapshots

**Typical Sizes:**
- 100 images × 200 snapshots (after aggregation) × 150 bytes = ~3 MB
- Well within Gist limits (100 MB)

### Extension Performance

**Data Fetching:**
```javascript
// Cache in memory (don't re-fetch on every chart re-render)
let cachedData = null;
let cacheTimestamp = null;

async function loadStats() {
  const now = Date.now();
  if (cachedData && (now - cacheTimestamp) < 60000) {
    return cachedData; // Use cache if < 1 minute old
  }

  const response = await chrome.runtime.sendMessage({ action: 'fetchStats' });
  if (response.data) {
    cachedData = response.data;
    cacheTimestamp = now;
  }
  return cachedData;
}
```

**Chart Rendering:**
```javascript
// Destroy old chart before creating new one
if (window.chartInstance) {
  window.chartInstance.destroy();
}
window.chartInstance = new Chart(ctx, config);
```

**Time Range Filtering:**
```javascript
// Pre-sort snapshots once
const sortedSnapshots = data.totalSnapshots.sort((a, b) =>
  new Date(a.timestamp) - new Date(b.timestamp)
);

// Binary search for time range (O(log n) instead of O(n))
function filterByTimeRange(snapshots, days) {
  if (days === 'all') return snapshots;

  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  const index = snapshots.findIndex(s =>
    new Date(s.timestamp).getTime() >= cutoff
  );

  return snapshots.slice(Math.max(0, index));
}
```

### GitHub Actions Optimization

**Caching:**
```yaml
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'
    cache-dependency-path: scripts/package-lock.json
```
- Dependencies cached between runs
- Saves ~30 seconds per run

**Efficient npm install:**
```yaml
- name: Install dependencies
  run: cd scripts && npm ci
```
- `npm ci` (clean install) is faster and more reliable than `npm install`
- Uses exact versions from package-lock.json

---

## Summary

This system provides **automated, efficient, and accurate** tracking of Civitai image statistics with:

✅ **Smart data collection** - Tiered refresh based on image age
✅ **Fresh stats** - Individual re-fetching bypasses stale cache
✅ **Historical tracking** - Time-series data for every image
✅ **Scalable storage** - Automatic aggregation prevents size issues
✅ **Beautiful visualization** - Interactive charts with date range selection
✅ **Zero maintenance** - Fully automated via GitHub Actions
✅ **Free hosting** - GitHub Gist + Actions free tier
✅ **Privacy-focused** - No third-party services, all open source

**Key Innovation:** Tiered refresh strategy balances data freshness with API efficiency, making it practical to track hundreds of images over long periods without hitting rate limits or requiring paid infrastructure.
