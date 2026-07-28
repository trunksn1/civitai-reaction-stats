# Improvement Plan — Civitai Reaction Stats

*Companion to [ADVERSARIAL_REVIEW.md](./ADVERSARIAL_REVIEW.md). Work happens on the
`rework/review-and-plan` branch (and children); each phase is independently shippable and
lands as its own PR to `main`.*

Legend: **[S]** small (<1h), **[M]** medium (half day), **[L]** large (multi-day).

---

## Phase 0 — Housekeeping

| # | Task | Size |
|---|------|------|
| 0.1 | **Keep `analysis/` exactly where it is** (owner decision — do not delete or move). It's a weekly reaction-distribution study from another project and serves as prior art: its day-of-week × hour aggregation seeds feature 6.2. Optionally add a provenance note at the top of `analysis/README.md`. | S |
| 0.2 | ✅ Set `DEBUG = false` in `extension/content/content.js`; gate future logging behind it. | S |
| 0.3 | ✅ Remove unused `"scripting"` permission from `extension/manifest.json`. | S |

## Phase 1 — Correctness fixes (collector)

All in `scripts/fetch-stats.js` unless noted.

| # | Task | Detail | Size |
|---|------|--------|------|
| 1.1 | ✅ Throw on 429 exhaustion | In `fetchWithRetry`, track that the loop can exit via the 429 path; after the final attempt `throw new Error('Rate limited after N retries: ' + url)` instead of falling through to `undefined`. | S |
| 1.2 | ✅ Tier escalation only once per day | In `getRefreshTier()`, return `monthly`/`quarterly` only when `now.getUTCHours() === 0`; other hours on the 1st behave as `daily`. Manual override unchanged. | S |
| 1.3 | ✅ Workflow concurrency group | Add `concurrency: { group: collect-stats, cancel-in-progress: false }` to `.github/workflows/collect-stats.yml`. | S |
| 1.4 | ✅ Compact JSON output | `JSON.stringify(data)` (no indent) in `updateGist`. Log size before/after on first deploy to confirm the win. | S |
| 1.5 | ✅ Real integrity check | Before merging, record `preMergeSnapshotCount` (sum over existing images). After merge+retention, require `postCount >= preCount - retentionRemoved` where `retentionRemoved` is counted by `applyRetentionPolicy` (return `{snapshots, removed}` or count at call sites). Abort on violation. | M |
| 1.6 | ✅ Escape hatch for the ratchet | Add `RESET_IMAGE_IDS` env (comma-separated ids): for listed images, skip the `Math.max` clamp for one run so a corrupted inflated value can be corrected. Document in README troubleshooting. | M |
| 1.7 | ✅ Demote permanently-zero images | If an image has 0 total reactions **and** `createdAt` older than 30 days, refresh it on the monthly tier only (instead of hourly forever). | S |

## Phase 2 — Shared snapshot codec

| # | Task | Detail | Size |
|---|------|--------|------|
| 2.1 | Create `shared/snapshot-codec.js` | Single source of truth: `FIELDS` table (`likes↔dl`, `hearts↔dh`, …), `isDelta()`, `resolveAll()`, `resolveLast()`, `encodeAsDeltas()`, `computeDeltas()` (clamped). Plain ESM, no deps. | M |
| 2.2 | Use it in the collector | Replace `isDelta` / `resolveSnapshot` / `resolveAllSnapshots` / `encodeAsDeltas` in `fetch-stats.js`. `scripts/package.json` gets a relative import (or copy step). | M |
| 2.3 | Use it in the extension | Replace `resolveSnapshots`, inline delta detection and `computeDeltas` in `extension/stats-page/stats.js`. Extension has no bundler: include `shared/snapshot-codec.js` as a plain script before `stats.js` (expose a global) — keep it dual-mode (ESM export + `globalThis` fallback). | M |
| 2.4 | Codec tests | Add `scripts/test-codec.js` (plain node asserts, no framework): round-trip encode/decode, `_d` marker, zero-delta runs, unknown-key tolerance. Run in CI before collect. | M |

*Adding any future stat field then means one entry in `FIELDS`.*

## Phase 3 — Collector efficiency

| # | Task | Detail | Size |
|---|------|--------|------|
| 3.1 | Incremental discovery | Pass known image IDs (from existing gist data) into `fetchUserImagesFromHost`; stop paginating a level when a full page contains only known IDs. Force full sweep when tier ≠ daily or `FULL_DISCOVERY=true`. | M |
| 3.2 | Discovery telemetry | Log pages fetched per level/host before vs after (validates 3.1). | S |
| 3.3 | (Optional) positional snapshot arrays | `[t, dl, dh, dla, dc, dco, dbu, dcol, dvi]` in stored JSON via the codec. Only if gist size is still a concern after 1.4; requires codec versioning (`formatVersion` field, read both). | L |

## Phase 4 — Chart correctness (extension)

| # | Task | Detail | Size |
|---|------|--------|------|
| 4.1 | Time-scale x-axis | Bundle `chartjs-adapter-date-fns` (or luxon) into `extension/lib/`; switch overview + per-image charts to `scales.x.type: 'time'` with raw timestamps as `{x, y}` points. Verify "All" view no longer compresses months into the same width as days. | M |
| 4.2 | Fixed-interval delta buckets | Replace per-snapshot `computeDeltas` for bar charts with calendar bucketing (reuse/generalize `dailyActivity`): 1d → hourly buckets, 7d → 6h, 30d/90d → daily. Bars become comparable. | M |
| 4.3 | Stacked delta bars | In delta mode, render likes/hearts/laughs/cries as a stacked bar (stack = total); drop the separate "Total" series there. Keep "Total" as a line only in cumulative mode, default-off. | M |
| 4.4 | `civitai.red` support in extension | Add `https://civitai.red/*` to `host_permissions` + `content_scripts.matches` so the Stats menu also appears there. | S |
| 4.5 | Stepped-line cumulative mode | Render cumulative lines with `stepped: 'before'` so sparse change-only snapshots don't draw invented slopes across silent gaps. Add a log-scale toggle for the "All" range. | S |
| 4.6 | Declutter series defaults | Cumulative mode defaults to Total + likes + hearts visible; laughs/cries/buzz/collects opt-in. In stacked delta mode (4.3) hide the redundant Total series. | S |
| 4.7 | Card sparklines | Always-visible total-reactions sparkline (no axes) on each image card and inside each summary tile; the full multi-series chart stays behind the expand. | M |

## Phase 5 — Extension-first architecture (share without GitHub Actions)

The strategic phase. Goal: **install from Web Store → works**, no fork/gist/PAT.
Rationale: stats are cumulative counters, so browser-open-only collection loses
resolution, never totals.

**Coexistence guarantee: this phase adds a mode, it does not replace anything.** The
existing GitHub Actions + gist pipeline keeps running untouched and remains the owner's
authoritative 24/7 dataset. The extension offers a data-source choice — *gist* (today's
behavior, stays the default for anyone already configured), *local* (in-browser
collection), or both side by side. A later optional feature can even merge the two
histories (union by timestamp — safe because snapshots are cumulative).

| # | Task | Detail | Size |
|---|------|--------|------|
| 5.1 | Storage layer | IndexedDB wrapper in the service worker (`extension/lib/db.js`): same logical schema as the gist JSON (meta, totalSnapshots, per-image snapshots). Add `unlimitedStorage` permission. | M |
| 5.2 | Port collector into service worker | New `extension/collector.js` reusing the codec + tier logic: discovery (incremental, both hosts), per-image tRPC refresh, clamping, retention. Fetches run with the user's cookies — no API key needed. Rate limits: keep batch=5 / 300ms. | L |
| 5.3 | Scheduling | `chrome.alarms.create('collect', {periodInMinutes: 45})`; on fire, skip if last successful run < 30 min ago; catch-up run on browser startup. MV3 note: each alarm wakes the SW fresh — collector must checkpoint progress (per-phase) to survive SW termination on long runs. | M |
| 5.4 | Data-source abstraction | `stats.js` reads via one interface with two providers: `local` (IndexedDB) and `gist` (current behavior). Popup gets a source selector: "Collect locally (default)" / "Read from Gist URL". | M |
| 5.5 | Onboarding | First-run: detect logged-in username via Civitai session (`/api/trpc` me query or parse from page), confirm in popup, start first collection with progress UI. | M |
| 5.6 | Import/export | Export local DB as `stats.json` (same schema — the collector's format is the interchange format); import an existing gist file to keep history when migrating from the Actions setup. | M |
| 5.7 | Web Store packaging | Icons/screenshots, privacy policy (all data local; nothing leaves the browser in local mode — also fixes the public-prompt privacy issue), zip pipeline, submit. | M |
| 5.8 | Docs rewrite | README: "Install extension" as the primary path; GitHub Actions + gist demoted to an optional "24/7 collection" appendix for power users. | M |

*Non-goal: removing the Actions path. It stays as the high-fidelity option and as the
multi-device sync backend (extension can keep reading the gist).*

## Phase 6 — New visualizations & fun (after 4 + 5.1)

Ordered by delight-per-effort; each is an independent widget on the Overview tab.

| # | Feature | Data source | Size |
|---|---------|-------------|------|
| 6.1 | Calendar heatmap (GitHub-style, reactions gained/day, 12 months) | existing total snapshots | M |
| 6.2 | Best time to post — DoW × hour heatmap of reaction inflow; port aggregation approach from the old `analysis/` script but feed it per-user snapshot deltas | existing snapshots | M |
| 6.3 | Records & milestones — best day, gaining streak, next round-number milestone with linear-projection ETA | existing | M |
| 6.4 | Distribution histogram + "top N images = X% of reactions" | existing | S |
| 6.5 | Week-vs-last-week sparklines on summary cards | existing | S |
| 6.6 | Image velocity / half-life + "hidden gems" (old images still accelerating) | existing | M |
| 6.7 | Reaction personality (funniest / most loved / most tipped) | existing | S |
| 6.8 | "On this day" (posted a year ago + earned since) | existing | S |
| 6.9 | Monthly recap card exported as PNG (canvas-rendered, Wrapped-style) | existing | L |
| 6.10 | Prompt/keyword performance correlation — requires keeping more of `meta.prompt` (or a keyword set) at collection time | collector change + UI | L |

## Suggested order & dependencies

```
Phase 0 ─┐
Phase 1 ─┼─► Phase 2 (codec) ─► Phase 3 (efficiency)
         │                    └► Phase 5 (extension-first) ─► Phase 6
         └─► Phase 4 (charts, independent) ──────────────────┘
```

- Phases 0–1 first: small, kills real bugs, no design decisions.
- Phase 2 before 3 and 5 (both reuse the codec).
- Phase 4 anytime (pure frontend).
- Phase 6 lands incrementally after 4; items needing local collection wait for 5.1.

## Open decisions (to settle before Phase 5)

1. **Chrome Web Store account** — publish under which identity? ($5 one-time dev fee.)
2. **Firefox?** MV3 + alarms work there too with minor manifest tweaks — in scope or later?
3. **History migration default** — when a gist-mode user switches to local mode, import
   automatically or on demand?

~~4. `analysis/` destination~~ — **resolved: it stays in this repo, untouched** (owner
decision, 2026-07-28).
