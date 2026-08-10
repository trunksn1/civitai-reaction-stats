/**
 * Safe rendering helpers for data that originated in a Gist or on Civitai.
 * The dashboard still uses template strings for layout, so both text and URL
 * values must be made safe before entering HTML attribute contexts.
 */
(function (global) {
  'use strict';

  const ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  function escapeHtml(value) {
    if (value == null) return '';
    return String(value).replace(/[&<>"']/g, char => ESCAPES[char]);
  }

  function isCivitaiHost(hostname) {
    return hostname === 'civitai.com' || hostname.endsWith('.civitai.com') ||
      hostname === 'civitai.red' || hostname.endsWith('.civitai.red');
  }

  function safeCivitaiUrl(value, fallback = '#') {
    try {
      const parsed = new URL(String(value));
      return parsed.protocol === 'https:' && isCivitaiHost(parsed.hostname)
        ? parsed.toString()
        : fallback;
    } catch {
      return fallback;
    }
  }

  const SafeValues = { escapeHtml, safeCivitaiUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = SafeValues;
  global.SafeValues = SafeValues;
})(typeof globalThis !== 'undefined' ? globalThis : this);
