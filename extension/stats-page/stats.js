/**
 * Civitai Reaction Stats - Stats Page Logic
 * Handles data fetching, chart rendering, and UI interactions
 */

// State
let statsData = null;
let overviewChart = null;
let currentTimeRange = '30d';
let visibleLines = {
  total: true,
  likes: true,
  hearts: true,
  laughs: true,
  cries: true
};
let displayedImages = 10;
const IMAGES_PER_PAGE = 10;

// Colors matching Civitai's palette
const CHART_COLORS = {
  total: '#be4bdb',
  likes: '#228be6',
  hearts: '#f06595',
  laughs: '#fcc419',
  cries: '#748ffc',
  comments: '#69db7c'
};

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
  setupEventListeners();
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

  // Line toggles
  document.querySelectorAll('#lineToggles input').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      visibleLines[checkbox.dataset.line] = checkbox.checked;
      updateChart();
    });
  });

  // Sort selector
  document.getElementById('sortSelect').addEventListener('change', (e) => {
    displayedImages = IMAGES_PER_PAGE;
    renderImages(e.target.value);
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
  const snapshots = statsData.totalSnapshots || [];
  const latest = snapshots[snapshots.length - 1] || {};

  const total = (latest.likes || 0) + (latest.hearts || 0) +
                (latest.laughs || 0) + (latest.cries || 0);

  document.getElementById('totalReactions').textContent = formatNumber(total);
  document.getElementById('totalLikes').textContent = formatNumber(latest.likes || 0);
  document.getElementById('totalHearts').textContent = formatNumber(latest.hearts || 0);
  document.getElementById('totalLaughs').textContent = formatNumber(latest.laughs || 0);
  document.getElementById('totalCries').textContent = formatNumber(latest.cries || 0);
  document.getElementById('totalComments').textContent = formatNumber(latest.comments || 0);
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

  overviewChart = new Chart(ctx, {
    type: 'line',
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
              return `${context.dataset.label}: ${formatNumber(context.parsed.y)}`;
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
          beginAtZero: true
        }
      }
    }
  });
}

/**
 * Update chart with current settings
 */
function updateChart() {
  if (!overviewChart) return;

  const data = getChartData();
  overviewChart.data = data;
  overviewChart.update();
}

/**
 * Get chart data based on current time range and visible lines
 */
function getChartData() {
  const snapshots = filterByTimeRange(statsData.totalSnapshots || []);

  const labels = snapshots.map(s => formatChartDate(new Date(s.timestamp)));

  const datasets = [];

  if (visibleLines.total) {
    datasets.push({
      label: 'Total',
      data: snapshots.map(s => (s.likes || 0) + (s.hearts || 0) + (s.laughs || 0) + (s.cries || 0)),
      borderColor: CHART_COLORS.total,
      backgroundColor: CHART_COLORS.total + '20',
      borderWidth: 2,
      tension: 0.3,
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
      tension: 0.3,
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
      tension: 0.3,
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
      tension: 0.3,
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
      tension: 0.3,
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
function filterByTimeRange(snapshots) {
  if (currentTimeRange === 'all') {
    return snapshots;
  }

  const now = Date.now();
  const ranges = {
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000
  };

  const threshold = now - ranges[currentTimeRange];

  return snapshots.filter(s => new Date(s.timestamp).getTime() >= threshold);
}

/**
 * Render images section
 */
function renderImages(sortBy = 'newest') {
  const images = sortImages([...(statsData.images || [])], sortBy);
  const grid = document.getElementById('imagesGrid');
  const loadMoreContainer = document.getElementById('loadMoreContainer');

  // Update count
  document.getElementById('imageCount').textContent = `${images.length} images`;

  // Get images to display
  const toDisplay = images.slice(0, displayedImages);

  grid.innerHTML = toDisplay.map(img => createImageCard(img)).join('');

  // Show/hide load more button
  loadMoreContainer.style.display = displayedImages < images.length ? 'flex' : 'none';
}

/**
 * Sort images
 */
function sortImages(images, sortBy) {
  switch (sortBy) {
    case 'oldest':
      return images.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    case 'reactions':
      return images.sort((a, b) => {
        const aTotal = getTotalReactions(a.currentStats);
        const bTotal = getTotalReactions(b.currentStats);
        return bTotal - aTotal;
      });
    case 'comments':
      return images.sort((a, b) => (b.currentStats?.comments || 0) - (a.currentStats?.comments || 0));
    case 'newest':
    default:
      return images.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
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
  const stats = image.currentStats || {};
  const date = image.createdAt ? formatDate(new Date(image.createdAt)) : 'Unknown';

  return `
    <div class="image-card">
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
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
            ${formatNumber(stats.likes || 0)}
          </span>
          <span class="stat-badge hearts">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            ${formatNumber(stats.hearts || 0)}
          </span>
          <span class="stat-badge laughs">
            <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
            ${formatNumber(stats.laughs || 0)}
          </span>
          <span class="stat-badge cries">
            <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
            ${formatNumber(stats.cries || 0)}
          </span>
          <span class="stat-badge comments">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            ${formatNumber(stats.comments || 0)}
          </span>
        </div>
      </div>
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
function formatChartDate(date) {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });
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

// Initialize on load
init();
