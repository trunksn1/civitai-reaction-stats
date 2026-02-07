/**
 * Civitai Reaction Stats - Content Script
 * Injects "Stats" menu item into Civitai's user dropdown menu
 */

const STATS_ITEM_ID = 'civitai-stats-menu-item';
let observerActive = false;

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
    return;
  }

  // Verify this looks like a user menu (has typical items like Settings, Profile)
  const menuText = menu.textContent.toLowerCase();
  const isUserMenu = menuText.includes('profile') ||
                     menuText.includes('settings') ||
                     menuText.includes('account') ||
                     menuText.includes('sign out') ||
                     menuText.includes('log out');

  if (!isUserMenu) {
    return;
  }

  const statsItem = createStatsMenuItem();
  const insertBefore = findInsertPosition(menu);

  if (insertBefore) {
    insertBefore.parentNode.insertBefore(statsItem, insertBefore);
  } else {
    menu.appendChild(statsItem);
  }

  console.log('[Civitai Stats] Menu item injected');
}

/**
 * Check for dropdown menus and inject if found
 */
function checkForMenus() {
  // Look for Mantine dropdown menus or any role="menu" element
  const menus = document.querySelectorAll('[role="menu"], [class*="mantine-Menu-dropdown"]');

  menus.forEach(menu => {
    // Only process if visible
    const rect = menu.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
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
        shouldCheck = true;
        break;
      }
    }

    if (shouldCheck) {
      // Use requestAnimationFrame to batch checks
      requestAnimationFrame(checkForMenus);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  observerActive = true;
  console.log('[Civitai Stats] Observer active');
}

/**
 * Initialize the content script
 */
function init() {
  // Only run on civitai.com
  if (!window.location.hostname.includes('civitai.com')) {
    return;
  }

  console.log('[Civitai Stats] Content script loaded');

  // Set up observer for menu detection
  setupObserver();

  // Also check immediately in case menu is already open
  checkForMenus();
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
