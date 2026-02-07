/**
 * Civitai Reaction Stats - Content Script
 * Injects "Stats" menu item into Civitai's user dropdown menu
 */

const STATS_ITEM_ID = 'civitai-stats-menu-item';
let observerActive = false;
const DEBUG = true; // Enable debug logging

/**
 * Debug logger
 */
function debug(...args) {
  if (DEBUG) {
    console.log('[Civitai Stats]', ...args);
  }
}

/**
 * Check if user appears to be logged in
 * Looks for profile-related elements in the header
 */
function isUserLoggedIn() {
  // Look for user menu button (avatar button in header)
  const userButton = document.querySelector('[aria-label*="Account"], [aria-label*="profile"], button[aria-haspopup="menu"] img');
  return !!userButton;
}

/**
 * Create the Stats menu item element
 */
function createStatsMenuItem() {
  const menuItem = document.createElement('button');
  menuItem.id = STATS_ITEM_ID;
  menuItem.setAttribute('role', 'menuitem');
  menuItem.setAttribute('tabindex', '-1');
  menuItem.className = 'civitai-stats-menu-item';

  // Icon + text
  menuItem.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"></line>
      <line x1="12" y1="20" x2="12" y2="4"></line>
      <line x1="6" y1="20" x2="6" y2="14"></line>
    </svg>
    <span>Stats</span>
  `;

  menuItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'openStatsPage' });

    // Close the menu by clicking elsewhere
    document.body.click();
  });

  return menuItem;
}

/**
 * Find a suitable position to inject the menu item
 * Returns the reference element to insert before, or null if should append
 */
function findInsertPosition(menu) {
  const menuItems = menu.querySelectorAll('[role="menuitem"]');
  if (menuItems.length === 0) return null;

  // Look for dividers or specific menu items
  // Try to insert before the last group (usually sign out)
  const dividers = menu.querySelectorAll('[role="separator"], hr, [class*="divider"]');

  if (dividers.length > 0) {
    // Insert before the last divider
    const lastDivider = dividers[dividers.length - 1];
    return lastDivider;
  }

  // Otherwise insert before the last menu item
  return menuItems[menuItems.length - 1];
}

/**
 * Inject the Stats menu item into a dropdown menu
 */
function injectStatsMenuItem(menu) {
  // Check if already injected
  if (menu.querySelector(`#${STATS_ITEM_ID}`)) {
    debug('Menu item already injected, skipping');
    return;
  }

  // Verify this looks like a user menu (has typical items like Settings, Profile)
  const menuText = menu.textContent.toLowerCase();
  debug('Menu text content:', menuText.substring(0, 200));

  // Check for user menu indicators - be more flexible with matching
  const userMenuKeywords = [
    'profile', 'settings', 'account', 'sign out', 'log out', 'logout',
    'buzz', 'creator', 'my stuff', 'collections', 'articles', 'bounties',
    'switch accounts', 'dark mode', 'vault'
  ];

  const isUserMenu = userMenuKeywords.some(keyword => menuText.includes(keyword));

  if (!isUserMenu) {
    debug('Not a user menu, skipping');
    return;
  }

  debug('User menu detected, injecting Stats item');
  const statsItem = createStatsMenuItem();
  const insertBefore = findInsertPosition(menu);

  if (insertBefore) {
    insertBefore.parentNode.insertBefore(statsItem, insertBefore);
    debug('Stats item inserted before:', insertBefore.textContent?.substring(0, 30));
  } else {
    menu.appendChild(statsItem);
    debug('Stats item appended to menu');
  }

  debug('Menu item injected successfully');
}

/**
 * Check for dropdown menus and inject if found
 */
function checkForMenus() {
  // Multiple selectors to catch Mantine menus with various class patterns
  const selectors = [
    '[role="menu"]',
    '[class*="mantine-Menu-dropdown"]',
    '[class*="Menu-dropdown"]',
    '[class*="mantine-"][class*="Menu"][class*="dropdown"]',
    '.mantine-Menu-dropdown',
    '[data-menu-dropdown]',
    '[class*="Popover-dropdown"]',
    // Also check for menu items container patterns
    'div[class*="mantine-"][role="presentation"]'
  ];

  const selectorString = selectors.join(', ');
  const menus = document.querySelectorAll(selectorString);

  debug(`Found ${menus.length} potential menus`);

  menus.forEach((menu, index) => {
    // Only process if visible
    const rect = menu.getBoundingClientRect();
    const style = window.getComputedStyle(menu);
    const isVisible = rect.width > 0 && rect.height > 0 &&
                      style.display !== 'none' &&
                      style.visibility !== 'hidden' &&
                      style.opacity !== '0';

    if (isVisible) {
      debug(`Processing visible menu ${index}:`, menu.className?.substring(0, 100));
      injectStatsMenuItem(menu);
    }
  });
}

/**
 * Set up MutationObserver to detect menu appearances
 * Required for SPA navigation and dynamically created menus
 */
function setupObserver() {
  if (observerActive) return;

  const observer = new MutationObserver((mutations) => {
    // Check if any mutations added nodes that could be menus
    let shouldCheck = false;

    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        // Check if any added node might be or contain a menu
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const className = node.className || '';
            const role = node.getAttribute?.('role') || '';

            // Check if this node or its content might be a menu
            if (role === 'menu' ||
                className.includes?.('Menu') ||
                className.includes?.('dropdown') ||
                className.includes?.('mantine') ||
                node.querySelector?.('[role="menu"], [class*="Menu-dropdown"]')) {
              shouldCheck = true;
              break;
            }
          }
        }
      }
      if (shouldCheck) break;
    }

    if (shouldCheck) {
      // Use requestAnimationFrame to batch checks
      requestAnimationFrame(checkForMenus);
      // Also check after a small delay for menus that animate in
      setTimeout(checkForMenus, 50);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  observerActive = true;
  debug('MutationObserver active');
}

/**
 * Initialize the content script
 */
function init() {
  // Only run on civitai.com
  if (!window.location.hostname.includes('civitai.com')) {
    return;
  }

  debug('Content script loaded on', window.location.href);

  // Set up observer for menu detection
  setupObserver();

  // Also check immediately in case menu is already open
  checkForMenus();

  // Additionally, listen for click events on potential menu triggers
  // This helps catch menus that appear from specific user interactions
  document.addEventListener('click', () => {
    // Small delay to allow menu to render
    setTimeout(checkForMenus, 100);
    setTimeout(checkForMenus, 300);
  }, true);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
