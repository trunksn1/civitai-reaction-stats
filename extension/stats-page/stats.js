/**
 * Civitai Reaction Stats - Stats Page Logic
 * Handles data fetching, chart rendering, and UI interactions
 */

// State
let statsData = null;
let overviewChart = null;
let currentTimeRange = '1d';
let currentChartType = 'auto'; // 'auto', 'line', 'bar'
const imageChartTypes = new Map(); // Map<imageId, 'auto'|'line'|'bar'>
let visibleLines = {
  total: true,
  likes: true,
  hearts: true,
  laughs: true,
  cries: true,
  buzz: true,
  collects: true
};
let displayedImages = 10;
const IMAGES_PER_PAGE = 10;

// Track per-image chart state
const imageCharts = new Map(); // Map<imageId, Chart>
const imageTimeRanges = new Map(); // Map<imageId, timeRange>
let imageLineVisibility = { total: true, likes: true, hearts: true, laughs: true, cries: true, buzz: true, collects: true };

// Emoji labels for chart tooltips
const LABEL_EMOJI = {
  'Total': '\u{1F310}',      // 🌐
  'Likes': '\u{1F44D}',      // 👍
  'Hearts': '\u2764\uFE0F',  // ❤️
  'Laughs': '\u{1F604}',     // 😄
  'Cries': '\u{1F622}',      // 😢
  'Buzz': '\u26A1',           // ⚡
  'Collects': '\u{1F516}'    // 🔖
};

/**
 * Check if the given time range should use delta mode (reactions gained per period)
 */
function isDeltaMode(timeRange) {
  return ['1d', '7d', '30d', '90d'].includes(timeRange);
}

/**
 * Compute deltas from resolved (absolute) snapshots.
 * Each point becomes the difference from the previous point.
 * Negative deltas are clamped to 0 (API caching artifacts).
 * The first point is dropped (no previous to diff against).
 */
function computeDeltas(snapshots) {
  if (!snapshots || snapshots.length < 2) return [];
  const result = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    result.push({
      timestamp: curr.timestamp,
      likes: Math.max(0, (curr.likes || 0) - (prev.likes || 0)),
      hearts: Math.max(0, (curr.hearts || 0) - (prev.hearts || 0)),
      laughs: Math.max(0, (curr.laughs || 0) - (prev.laughs || 0)),
      cries: Math.max(0, (curr.cries || 0) - (prev.cries || 0)),
      comments: Math.max(0, (curr.comments || 0) - (prev.comments || 0)),
      buzz: Math.max(0, (curr.buzz || 0) - (prev.buzz || 0)),
      collects: Math.max(0, (curr.collects || 0) - (prev.collects || 0)),
      views: Math.max(0, (curr.views || 0) - (prev.views || 0))
    });
  }
  return result;
}

/**
 * Get effective chart type based on time range and user override.
 * 'auto' = bar for delta mode, line for cumulative.
 */
function getEffectiveChartType(timeRange, override) {
  if (override && override !== 'auto') return override;
  return isDeltaMode(timeRange) ? 'bar' : 'line';
}

/**
 * Resolve delta-encoded snapshots back to absolute values.
 * Absolute snapshots pass through unchanged; delta snapshots (with d* keys)
 * are accumulated on top of the previous absolute values.
 */
function resolveSnapshots(snapshots) {
  if (!snapshots || snapshots.length === 0) return [];
  const result = [];
  let current = { likes: 0, hearts: 0, laughs: 0, cries: 0, comments: 0, buzz: 0, collects: 0, views: 0 };

  for (const s of snapshots) {
    if ('dl' in s || 'dh' in s || 'dla' in s || 'dc' in s || 'dco' in s || '_d' in s || 'dbu' in s || 'dcol' in s || 'dvi' in s) {
      current = {
        likes: current.likes + (s.dl || 0),
        hearts: current.hearts + (s.dh || 0),
        laughs: current.laughs + (s.dla || 0),
        cries: current.cries + (s.dc || 0),
        comments: current.comments + (s.dco || 0),
        buzz: current.buzz + (s.dbu || 0),
        collects: current.collects + (s.dcol || 0),
        views: current.views + (s.dvi || 0)
      };
    } else {
      current = {
        likes: s.likes || 0,
        hearts: s.hearts || 0,
        laughs: s.laughs || 0,
        cries: s.cries || 0,
        comments: s.comments || 0,
        buzz: s.buzz || 0,
        collects: s.collects || 0,
        views: s.views || 0
      };
    }
    result.push({ timestamp: s.timestamp, ...current });
  }
  return result;
}

// Default colors matching Civitai's palette
const DEFAULT_CHART_COLORS = {
  total: '#be4bdb',
  likes: '#228be6',
  hearts: '#f06595',
  laughs: '#fcc419',
  cries: '#748ffc',
  comments: '#69db7c',
  buzz: '#ff922b',
  collects: '#20c997'
};

// Active colors (may be overridden by user)
const CHART_COLORS = { ...DEFAULT_CHART_COLORS };

// DOM Elements
const loadingEl = document.getElementById('loading');
const errorContainerEl = document.getElementById('errorContainer');
const errorMessageEl = document.getElementById('errorMessage');
const mainContentEl = document.getElementById('mainContent');
const lastUpdatedEl = document.getElementById('lastUpdated');
const refreshBtn = document.getElementById('refreshBtn');
const retryBtn = document.getElementById('retryBtn');

/**
 * Initialize the stats page
 */
async function init() {
  await loadCustomColors();
  await loadChartTypePreference();
  setupEventListeners();
  setupColorSettings();
  await loadData();
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
  // Refresh button
  refreshBtn.addEventListener('click', () => loadData());
  retryBtn.addEventListener('click', () => loadData());

  // Time range selector
  document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTimeRange = btn.dataset.range;
      updateChart();
    });
  });

  // Chart type toggle
  document.querySelectorAll('#chartTypeToggle .chart-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#chartTypeToggle .chart-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentChartType = btn.dataset.type;
      saveChartTypePreference();
      updateChart();
    });
  });

  // Line toggles
  document.querySelectorAll('#lineToggles input').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      visibleLines[checkbox.dataset.line] = checkbox.checked;
      updateChart();
    });
  });

  // Global image line toggles
  document.querySelectorAll('#imageLineToggles input').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      imageLineVisibility[checkbox.dataset.line] = checkbox.checked;
      // Re-render all open image charts
      imageCharts.forEach((chart, imageId) => {
        const image = statsData?.images?.find(img => img.id === imageId);
        if (image) {
          const timeRange = imageTimeRanges.get(imageId) || 'all';
          renderImageChart(image, timeRange);
        }
      });
    });
  });

  // Sort selector
  document.getElementById('sortSelect').addEventListener('change', (e) => {
    const reactionTypeSelect = document.getElementById('reactionTypeSelect');
    reactionTypeSelect.style.display = e.target.value === 'reactions' ? '' : 'none';
    displayedImages = IMAGES_PER_PAGE;
    renderImages(e.target.value);
  });

  // Reaction type selector
  document.getElementById('reactionTypeSelect').addEventListener('change', () => {
    displayedImages = IMAGES_PER_PAGE;
    renderImages(document.getElementById('sortSelect').value);
  });

  // Load more button
  document.getElementById('loadMoreBtn').addEventListener('click', () => {
    displayedImages += IMAGES_PER_PAGE;
    renderImages(document.getElementById('sortSelect').value);
  });
}

/**
 * Load data from the Gist
 */
async function loadData() {
  showLoading();

  try {
    const response = await chrome.runtime.sendMessage({ action: 'fetchGistData' });

    if (!response.success) {
      throw new Error(response.error);
    }

    statsData = response.data;
    showContent();
    renderStats();
  } catch (error) {
    showError(error.message);
  }
}

/**
 * Show loading state
 */
function showLoading() {
  loadingEl.style.display = 'flex';
  errorContainerEl.style.display = 'none';
  mainContentEl.style.display = 'none';
  refreshBtn.classList.add('loading');
}

/**
 * Show error state
 */
function showError(message) {
  loadingEl.style.display = 'none';
  errorContainerEl.style.display = 'flex';
  mainContentEl.style.display = 'none';
  errorMessageEl.textContent = message;
  refreshBtn.classList.remove('loading');
}

/**
 * Show main content
 */
function showContent() {
  loadingEl.style.display = 'none';
  errorContainerEl.style.display = 'none';
  mainContentEl.style.display = 'block';
  refreshBtn.classList.remove('loading');
}

/**
 * Render all stats
 */
function renderStats() {
  if (!statsData) return;

  // Update last updated time
  if (statsData.lastUpdated) {
    const date = new Date(statsData.lastUpdated);
    lastUpdatedEl.textContent = `Last updated: ${formatDate(date)}`;
  }

  // Render summary cards
  renderSummaryCards();

  // Render chart
  renderChart();

  // Render images
  renderImages(document.getElementById('sortSelect').value);
}

/**
 * Render summary cards with current totals
 */
function renderSummaryCards() {
  const snapshots = resolveSnapshots(statsData.totalSnapshots || []);
  const latest = snapshots[snapshots.length - 1] || {};

  const total = (latest.likes || 0) + (latest.hearts || 0) +
                (latest.laughs || 0) + (latest.cries || 0);

  // Use full numbers with comma separators for summary cards
  document.getElementById('totalReactions').textContent = total.toLocaleString();
  document.getElementById('totalLikes').textContent = (latest.likes || 0).toLocaleString();
  document.getElementById('totalHearts').textContent = (latest.hearts || 0).toLocaleString();
  document.getElementById('totalLaughs').textContent = (latest.laughs || 0).toLocaleString();
  document.getElementById('totalCries').textContent = (latest.cries || 0).toLocaleString();
  document.getElementById('totalComments').textContent = (latest.comments || 0).toLocaleString();
  document.getElementById('totalBuzz').textContent = (latest.buzz || 0).toLocaleString();
  document.getElementById('totalCollects').textContent = (latest.collects || 0).toLocaleString();
}

/**
 * Render the overview chart
 */
function renderChart() {
  const canvas = document.getElementById('overviewChart');
  const ctx = canvas.getContext('2d');

  if (overviewChart) {
    overviewChart.destroy();
  }

  const data = getChartData();
  const chartType = getEffectiveChartType(currentTimeRange, currentChartType);
  const deltaMode = isDeltaMode(currentTimeRange);

  // Update chart title
  const titleEl = document.getElementById('chartTitle');
  if (titleEl) {
    titleEl.textContent = deltaMode ? 'Reactions Gained' : 'Reactions Over Time';
  }

  overviewChart = new Chart(ctx, {
    type: chartType,
    data: data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: '#25262b',
          titleColor: '#fff',
          bodyColor: '#c1c2c5',
          borderColor: '#373a40',
          borderWidth: 1,
          padding: 12,
          displayColors: true,
          callbacks: {
            label: function(context) {
              const emoji = LABEL_EMOJI[context.dataset.label] || context.dataset.label;
              const value = context.parsed.y.toLocaleString();
              if (deltaMode) {
                return `${emoji}: +${value}`;
              }
              const idx = context.dataIndex;
              let delta = '';
              if (idx > 0) {
                const prev = context.dataset.data[idx - 1];
                const diff = context.parsed.y - prev;
                if (diff !== 0) {
                  delta = ` (${diff >= 0 ? '+' : ''}${diff.toLocaleString()})`;
                }
              }
              return `${emoji}: ${value}${delta}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: 'rgba(55, 58, 64, 0.5)',
            drawBorder: false
          },
          ticks: {
            color: '#909296',
            maxTicksLimit: 8
          }
        },
        y: {
          grid: {
            color: 'rgba(55, 58, 64, 0.5)',
            drawBorder: false
          },
          ticks: {
            color: '#909296',
            callback: value => formatNumber(value)
          },
          beginAtZero: true,
          title: deltaMode ? {
            display: true,
            text: 'Gained per period',
            color: '#909296',
            font: { size: 12 }
          } : { display: false }
        }
      }
    }
  });
}

/**
 * Update chart with current settings
 */
function updateChart() {
  renderChart();
}

/**
 * Get chart data based on current time range and visible lines
 */
function getChartData() {
  const resolved = filterByTimeRange(resolveSnapshots(statsData.totalSnapshots || []));
  const deltaMode = isDeltaMode(currentTimeRange);
  const snapshots = deltaMode ? computeDeltas(resolved) : resolved;

  const labels = snapshots.map(s => formatChartDate(new Date(s.timestamp), currentTimeRange));

  const datasets = [];

  if (visibleLines.total) {
    datasets.push({
      label: 'Total',
      data: snapshots.map(s => (s.likes || 0) + (s.hearts || 0) + (s.laughs || 0) + (s.cries || 0)),
      borderColor: CHART_COLORS.total,
      backgroundColor: CHART_COLORS.total + '20',
      borderWidth: 2,
      tension: 0,
      fill: false,
      pointRadius: snapshots.length > 50 ? 0 : 3,
      pointHoverRadius: 5
    });
  }

  if (visibleLines.likes) {
    datasets.push({
      label: 'Likes',
      data: snapshots.map(s => s.likes || 0),
      borderColor: CHART_COLORS.likes,
      backgroundColor: CHART_COLORS.likes + '20',
      borderWidth: 2,
      tension: 0,
      fill: false,
      pointRadius: snapshots.length > 50 ? 0 : 3,
      pointHoverRadius: 5
    });
  }

  if (visibleLines.hearts) {
    datasets.push({
      label: 'Hearts',
      data: snapshots.map(s => s.hearts || 0),
      borderColor: CHART_COLORS.hearts,
      backgroundColor: CHART_COLORS.hearts + '20',
      borderWidth: 2,
      tension: 0,
      fill: false,
      pointRadius: snapshots.length > 50 ? 0 : 3,
      pointHoverRadius: 5
    });
  }

  if (visibleLines.laughs) {
    datasets.push({
      label: 'Laughs',
      data: snapshots.map(s => s.laughs || 0),
      borderColor: CHART_COLORS.laughs,
      backgroundColor: CHART_COLORS.laughs + '20',
      borderWidth: 2,
      tension: 0,
      fill: false,
      pointRadius: snapshots.length > 50 ? 0 : 3,
      pointHoverRadius: 5
    });
  }

  if (visibleLines.cries) {
    datasets.push({
      label: 'Cries',
      data: snapshots.map(s => s.cries || 0),
      borderColor: CHART_COLORS.cries,
      backgroundColor: CHART_COLORS.cries + '20',
      borderWidth: 2,
      tension: 0,
      fill: false,
      pointRadius: snapshots.length > 50 ? 0 : 3,
      pointHoverRadius: 5
    });
  }

  if (visibleLines.buzz) {
    datasets.push({
      label: 'Buzz',
      data: snapshots.map(s => s.buzz || 0),
      borderColor: CHART_COLORS.buzz,
      backgroundColor: CHART_COLORS.buzz + '20',
      borderWidth: 2,
      tension: 0,
      fill: false,
      pointRadius: snapshots.length > 50 ? 0 : 3,
      pointHoverRadius: 5
    });
  }

  if (visibleLines.collects) {
    datasets.push({
      label: 'Collects',
      data: snapshots.map(s => s.collects || 0),
      borderColor: CHART_COLORS.collects,
      backgroundColor: CHART_COLORS.collects + '20',
      borderWidth: 2,
      tension: 0,
      fill: false,
      pointRadius: snapshots.length > 50 ? 0 : 3,
      pointHoverRadius: 5
    });
  }

  return { labels, datasets };
}

/**
 * Filter snapshots by time range
 */
function filterByTimeRange(snapshots, timeRange = null) {
  const range = timeRange || currentTimeRange;

  if (range === 'all') {
    return snapshots;
  }

  const now = Date.now();
  const ranges = {
    '1d': 1 * 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
    '1y': 365 * 24 * 60 * 60 * 1000
  };

  const threshold = now - ranges[range];

  return snapshots.filter(s => new Date(s.timestamp).getTime() >= threshold);
}

/**
 * Render images section
 */
function renderImages(sortBy = 'newest') {
  const images = sortImages([...(statsData.images || [])], sortBy);
  const grid = document.getElementById('imagesGrid');
  const loadMoreContainer = document.getElementById('loadMoreContainer');

  // Clean up existing charts before re-rendering
  imageCharts.forEach(chart => chart.destroy());
  imageCharts.clear();
  imageTimeRanges.clear();

  // Update count
  document.getElementById('imageCount').textContent = `${images.length} images`;

  // Get images to display
  const toDisplay = images.slice(0, displayedImages);

  grid.innerHTML = toDisplay.map(img => createImageCard(img)).join('');

  // Set up event listeners for chart toggles
  setupImageChartListeners(toDisplay);

  // Show/hide load more button
  loadMoreContainer.style.display = displayedImages < images.length ? 'flex' : 'none';
}

/**
 * Set up event listeners for image chart toggles and time selectors
 */
function setupImageChartListeners(images) {
  // Chart toggle buttons
  document.querySelectorAll('.image-chart-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const imageId = btn.dataset.imageId;
      const container = document.getElementById(`chart-container-${imageId}`);
      const isExpanded = container.classList.contains('visible');

      if (isExpanded) {
        // Collapse
        container.classList.remove('visible');
        btn.classList.remove('expanded');
        btn.querySelector('span').textContent = 'Show Chart';
      } else {
        // Expand
        container.classList.add('visible');
        btn.classList.add('expanded');
        btn.querySelector('span').textContent = 'Hide Chart';

        // Render chart if not already rendered
        if (!imageCharts.has(imageId)) {
          const image = images.find(img => img.id === imageId);
          if (image) {
            const timeRange = imageTimeRanges.get(imageId) || 'all';
            renderImageChart(image, timeRange);
          }
        }
      }
    });
  });

  // Per-image chart type toggle
  document.querySelectorAll('.image-chart-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const imageId = btn.dataset.imageId;
      const type = btn.dataset.type;

      const parent = btn.closest('.image-chart-type-toggle');
      parent.querySelectorAll('.image-chart-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      imageChartTypes.set(imageId, type);

      const image = images.find(img => img.id === imageId);
      if (image) {
        const timeRange = imageTimeRanges.get(imageId) || 'all';
        renderImageChart(image, timeRange);
      }
    });
  });

  // Time selector buttons for each image
  document.querySelectorAll('.image-time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const imageId = btn.dataset.imageId;
      const range = btn.dataset.range;

      // Update active state
      const parent = btn.closest('.image-time-selector');
      parent.querySelectorAll('.image-time-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Store and update chart
      imageTimeRanges.set(imageId, range);

      const image = images.find(img => img.id === imageId);
      if (image) {
        renderImageChart(image, range);
      }
    });
  });
}

/**
 * Render chart for a single image
 */
function renderImageChart(image, timeRange) {
  const canvasId = `image-chart-${image.id}`;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  // Destroy existing chart if any
  if (imageCharts.has(image.id)) {
    imageCharts.get(image.id).destroy();
  }

  const resolved = filterByTimeRange(resolveSnapshots(image.snapshots || []), timeRange);
  const deltaMode = isDeltaMode(timeRange);
  const snapshots = deltaMode ? computeDeltas(resolved) : resolved;

  if (snapshots.length < 2) {
    // Not enough data points
    canvas.style.display = 'none';
    const wrapper = canvas.closest('.image-chart-wrapper');
    if (!wrapper.querySelector('.image-chart-empty')) {
      wrapper.innerHTML = '<div class="image-chart-empty">Not enough data for selected time range</div>';
    }
    return;
  }

  canvas.style.display = 'block';
  const wrapper = canvas.closest('.image-chart-wrapper');
  const emptyMsg = wrapper.querySelector('.image-chart-empty');
  if (emptyMsg) emptyMsg.remove();

  const labels = snapshots.map(s => formatChartDate(new Date(s.timestamp), timeRange));

  const vis = imageLineVisibility;

  const datasets = [];

  if (vis.total) {
    datasets.push({
      label: 'Total',
      data: snapshots.map(s => (s.likes || 0) + (s.hearts || 0) + (s.laughs || 0) + (s.cries || 0)),
      borderColor: CHART_COLORS.total,
      backgroundColor: CHART_COLORS.total + '20',
      borderWidth: 2,
      tension: 0,
      fill: false,
      pointRadius: snapshots.length > 30 ? 0 : 2,
      pointHoverRadius: 4
    });
  }

  if (vis.likes) {
    datasets.push({
      label: 'Likes',
      data: snapshots.map(s => s.likes || 0),
      borderColor: CHART_COLORS.likes,
      borderWidth: 1.5,
      tension: 0,
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 3
    });
  }

  if (vis.hearts) {
    datasets.push({
      label: 'Hearts',
      data: snapshots.map(s => s.hearts || 0),
      borderColor: CHART_COLORS.hearts,
      borderWidth: 1.5,
      tension: 0,
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 3
    });
  }

  if (vis.laughs) {
    datasets.push({
      label: 'Laughs',
      data: snapshots.map(s => s.laughs || 0),
      borderColor: CHART_COLORS.laughs,
      borderWidth: 1.5,
      tension: 0,
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 3
    });
  }

  if (vis.cries) {
    datasets.push({
      label: 'Cries',
      data: snapshots.map(s => s.cries || 0),
      borderColor: CHART_COLORS.cries,
      borderWidth: 1.5,
      tension: 0,
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 3
    });
  }

  if (vis.buzz) {
    datasets.push({
      label: 'Buzz',
      data: snapshots.map(s => s.buzz || 0),
      borderColor: CHART_COLORS.buzz,
      borderWidth: 1.5,
      tension: 0,
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 3
    });
  }

  if (vis.collects) {
    datasets.push({
      label: 'Collects',
      data: snapshots.map(s => s.collects || 0),
      borderColor: CHART_COLORS.collects,
      borderWidth: 1.5,
      tension: 0,
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 3
    });
  }

  const chartType = getEffectiveChartType(timeRange, imageChartTypes.get(image.id));

  const chart = new Chart(ctx, {
    type: chartType,
    data: {
      labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: '#25262b',
          titleColor: '#fff',
          bodyColor: '#c1c2c5',
          borderColor: '#373a40',
          borderWidth: 1,
          padding: 8,
          displayColors: true,
          callbacks: {
            label: function(context) {
              const emoji = LABEL_EMOJI[context.dataset.label] || context.dataset.label;
              const value = context.parsed.y.toLocaleString();
              if (deltaMode) {
                return `${emoji}: +${value}`;
              }
              const idx = context.dataIndex;
              let delta = '';
              if (idx > 0) {
                const prev = context.dataset.data[idx - 1];
                const diff = context.parsed.y - prev;
                if (diff !== 0) {
                  delta = ` (${diff >= 0 ? '+' : ''}${diff.toLocaleString()})`;
                }
              }
              return `${emoji}: ${value}${delta}`;
            }
          }
        }
      },
      scales: {
        x: {
          display: false
        },
        y: {
          grid: {
            color: 'rgba(55, 58, 64, 0.3)',
            drawBorder: false
          },
          ticks: {
            color: '#909296',
            font: { size: 10 },
            callback: value => formatNumber(value)
          },
          beginAtZero: true,
          title: deltaMode ? {
            display: true,
            text: 'Gained per period',
            color: '#909296',
            font: { size: 10 }
          } : { display: false }
        }
      }
    }
  });

  imageCharts.set(image.id, chart);
}

/**
 * Sort images
 */
function sortImages(images, sortBy) {
  switch (sortBy) {
    case 'oldest':
      return images.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    case 'reactions': {
      const reactionType = document.getElementById('reactionTypeSelect')?.value || 'total';
      if (reactionType === 'total') {
        return images.sort((a, b) => getTotalReactions(getCurrentStats(b)) - getTotalReactions(getCurrentStats(a)));
      }
      return images.sort((a, b) => (getCurrentStats(b)[reactionType] || 0) - (getCurrentStats(a)[reactionType] || 0));
    }
    case 'comments':
      return images.sort((a, b) => (getCurrentStats(b).comments || 0) - (getCurrentStats(a).comments || 0));
    case 'newest':
    default:
      return images.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
}

/**
 * Get current stats from an image (latest snapshot or legacy currentStats)
 */
function getCurrentStats(image) {
  // Support new snapshots format — resolve deltas to get absolute values
  if (image.snapshots && image.snapshots.length > 0) {
    const resolved = resolveSnapshots(image.snapshots);
    return resolved[resolved.length - 1];
  }
  // Fallback to legacy format
  return image.currentStats || { likes: 0, hearts: 0, laughs: 0, cries: 0, comments: 0, buzz: 0, collects: 0, views: 0 };
}

/**
 * Get total reactions for an image
 */
function getTotalReactions(stats) {
  if (!stats) return 0;
  return (stats.likes || 0) + (stats.hearts || 0) + (stats.laughs || 0) + (stats.cries || 0);
}

/**
 * Create an image card HTML
 */
function createImageCard(image) {
  const stats = getCurrentStats(image);
  const date = image.createdAt ? formatDate(new Date(image.createdAt)) : 'Unknown';
  const hasSnapshots = image.snapshots && image.snapshots.length > 1;

  return `
    <div class="image-card" data-image-id="${escapeHtml(image.id)}">
      <div class="image-card-header">
        <div class="image-thumbnail">
          ${image.thumbnailUrl
            ? `<img src="${escapeHtml(image.thumbnailUrl)}" alt="" loading="lazy">`
            : '<div class="placeholder">?</div>'
          }
        </div>
        <div class="image-info">
          <div class="image-name">
            <a href="${escapeHtml(image.url)}" target="_blank" rel="noopener">
              ${escapeHtml(image.name || `Image ${image.id}`)}
            </a>
          </div>
          <div class="image-date">${date}</div>
          <div class="image-stats">
            <span class="stat-badge likes">
              &#x1F44D;
              ${formatNumber(stats.likes || 0)}
            </span>
            <span class="stat-badge hearts">
              &#x2764;&#xFE0F;
              ${formatNumber(stats.hearts || 0)}
            </span>
            <span class="stat-badge laughs">
              &#x1F604;
              ${formatNumber(stats.laughs || 0)}
            </span>
            <span class="stat-badge cries">
              &#x1F622;
              ${formatNumber(stats.cries || 0)}
            </span>
            <span class="stat-badge comments">
              &#x1F4AC;
              ${formatNumber(stats.comments || 0)}
            </span>
            <span class="stat-badge buzz">
              &#x26A1;
              ${formatNumber(stats.buzz || 0)}
            </span>
            <span class="stat-badge collects">
              &#x1F516;
              ${formatNumber(stats.collects || 0)}
            </span>
          </div>
        </div>
      </div>
      ${hasSnapshots ? `
        <button class="image-chart-toggle" data-image-id="${escapeHtml(image.id)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
          <span>Show Chart</span>
        </button>
        <div class="image-chart-container" id="chart-container-${escapeHtml(image.id)}">
          <div class="image-chart-controls">
            <div class="image-time-selector">
              <button class="image-time-btn" data-range="1d" data-image-id="${escapeHtml(image.id)}">1D</button>
              <button class="image-time-btn" data-range="7d" data-image-id="${escapeHtml(image.id)}">7D</button>
              <button class="image-time-btn" data-range="30d" data-image-id="${escapeHtml(image.id)}">30D</button>
              <button class="image-time-btn" data-range="1y" data-image-id="${escapeHtml(image.id)}">1Y</button>
              <button class="image-time-btn active" data-range="all" data-image-id="${escapeHtml(image.id)}">All</button>
            </div>
            <div class="image-chart-type-toggle" data-image-id="${escapeHtml(image.id)}">
              <button class="image-chart-type-btn active" data-type="auto" data-image-id="${escapeHtml(image.id)}" title="Auto">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4m-10-10h4m12 0h4"/></svg>
              </button>
              <button class="image-chart-type-btn" data-type="line" data-image-id="${escapeHtml(image.id)}" title="Line">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 17 9 11 13 15 21 7"/></svg>
              </button>
              <button class="image-chart-type-btn" data-type="bar" data-image-id="${escapeHtml(image.id)}" title="Bar">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/></svg>
              </button>
            </div>
          </div>
          <div class="image-chart-wrapper">
            <canvas id="image-chart-${escapeHtml(image.id)}"></canvas>
          </div>
        </div>
      ` : `
        <div class="image-chart-empty-note" style="font-size: 11px; color: var(--text-muted); margin-top: 8px; text-align: center;">
          Historical data will appear after more snapshots are collected
        </div>
      `}
    </div>
  `;
}

/**
 * Format a number with commas
 */
function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toLocaleString();
}

/**
 * Format a date for display
 */
function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Format a date for chart labels
 */
function formatChartDate(date, timeRange) {
  switch (timeRange) {
    case '1d':
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    case '7d':
      return date.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' +
             date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    case '30d':
    case '90d':
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    case '1y':
      return date.toLocaleDateString('en-US', { month: 'short' });
    case 'all':
    default:
      const year = date.getFullYear().toString().slice(-2);
      return date.toLocaleDateString('en-US', { month: 'short' }) + " '" + year;
  }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Load custom colors from storage and apply them
 */
async function loadCustomColors() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (response.success && response.settings.chartColors) {
      const custom = response.settings.chartColors;
      for (const key of Object.keys(DEFAULT_CHART_COLORS)) {
        if (custom[key]) {
          CHART_COLORS[key] = custom[key];
        }
      }
    }
  } catch (e) {
    // Silently use defaults
  }
  applyCSSColors();
}

/**
 * Apply CHART_COLORS to CSS custom properties
 */
function applyCSSColors() {
  const root = document.documentElement;
  for (const [key, color] of Object.entries(CHART_COLORS)) {
    root.style.setProperty(`--color-${key}`, color);
  }
}

/**
 * Set up color settings panel interactions
 */
function setupColorSettings() {
  const btn = document.getElementById('colorSettingsBtn');
  const panel = document.getElementById('colorSettingsPanel');
  const resetBtn = document.getElementById('resetColorsBtn');

  // Sync color inputs with current CHART_COLORS
  for (const key of Object.keys(DEFAULT_CHART_COLORS)) {
    const input = document.getElementById(`color-${key}`);
    if (input) {
      input.value = CHART_COLORS[key];
    }
  }

  // Toggle panel
  btn.addEventListener('click', () => {
    const isVisible = panel.classList.contains('visible');
    panel.classList.toggle('visible');
    btn.classList.toggle('active');
  });

  // Color change handlers
  panel.querySelectorAll('input[type="color"]').forEach(input => {
    input.addEventListener('input', () => {
      const line = input.dataset.line;
      CHART_COLORS[line] = input.value;
      applyCSSColors();
      if (overviewChart) updateChart();
      // Re-render any open image charts
      imageCharts.forEach((chart, imageId) => {
        const image = statsData?.images?.find(img => img.id === imageId);
        if (image) {
          const timeRange = imageTimeRanges.get(imageId) || 'all';
          renderImageChart(image, timeRange);
        }
      });
    });

    // Save on change (when user releases the picker)
    input.addEventListener('change', () => {
      saveCustomColors();
    });
  });

  // Reset button
  resetBtn.addEventListener('click', () => {
    for (const key of Object.keys(DEFAULT_CHART_COLORS)) {
      CHART_COLORS[key] = DEFAULT_CHART_COLORS[key];
      const input = document.getElementById(`color-${key}`);
      if (input) input.value = DEFAULT_CHART_COLORS[key];
    }
    applyCSSColors();
    if (overviewChart) updateChart();
    imageCharts.forEach((chart, imageId) => {
      const image = statsData?.images?.find(img => img.id === imageId);
      if (image) {
        const timeRange = imageTimeRanges.get(imageId) || 'all';
        renderImageChart(image, timeRange);
      }
    });
    // Clear from storage
    chrome.runtime.sendMessage({
      action: 'saveSettings',
      settings: { chartColors: null }
    });
  });
}

/**
 * Save custom colors to storage (only non-default values)
 */
function saveCustomColors() {
  const custom = {};
  for (const [key, defaultColor] of Object.entries(DEFAULT_CHART_COLORS)) {
    if (CHART_COLORS[key] !== defaultColor) {
      custom[key] = CHART_COLORS[key];
    }
  }
  chrome.runtime.sendMessage({
    action: 'saveSettings',
    settings: { chartColors: Object.keys(custom).length > 0 ? custom : null }
  });
}

/**
 * Save chart type preference to storage
 */
function saveChartTypePreference() {
  chrome.runtime.sendMessage({
    action: 'saveSettings',
    settings: { chartType: currentChartType !== 'auto' ? currentChartType : null }
  });
}

/**
 * Load chart type preference from storage
 */
async function loadChartTypePreference() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (response.success && response.settings.chartType) {
      currentChartType = response.settings.chartType;
      // Update toggle button UI
      document.querySelectorAll('#chartTypeToggle .chart-type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === currentChartType);
      });
    }
  } catch (e) {
    // Silently use default
  }
}

// Initialize on load
init();
