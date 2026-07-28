# Adversarial Review — Civitai Reaction Stats

*Date: 2026-07-28. Scope: full codebase — collector (`scripts/fetch-stats.js`), workflow
(`.github/workflows/collect-stats.yml`), Chrome extension (service worker, content script,
popup, stats page), manifest, and docs.*

## Overall verdict

For a personal tool this is genuinely better than most hobby projects. The hard-won API
knowledge (stale bulk stats, NSFW level splitting, the `.red` host split, gist truncation)
is encoded in the code and docs, the data-loss guards in `readGistData()` are exactly
right, and the delta encoding + retention tiering shows real thought.

But adversarially, there are real cracks — correctness bugs, efficiency waste, a sharing
story that requires the user to be a developer, and two chart-correctness problems.

---

## 1. Correctness bugs

### 1.1 `fetchWithRetry` silently returns `undefined` after exhausting 429 retries
`scripts/fetch-stats.js:61-97`. The 429 branch does `continue`; after the last attempt the
loop ends without throwing. The caller then explodes on `data.items` with a confusing
`TypeError: Cannot read properties of undefined` instead of a clear "rate limited after N
retries" error.

### 1.2 Tier logic multiplies work ×24 on tier days
`scripts/fetch-stats.js:139-158`. `getRefreshTier()` is date-based but the job runs
hourly, so on the 1st of a quarter **all 24 runs** do a full quarterly refresh of every
image. That is the opposite of what the tier system was built for. Escalated tiers should
only fire when `getUTCHours() === 0`.

### 1.3 The ratchet can never heal
`Math.max` clamping is applied at three layers: bulk-vs-individual merge
(`refreshImageStats`), per-image snapshots (`processImages`), and totals (`main`). One
inflated API response — or a cross-host merge picking up a wrong record — gets baked in
**forever**, with no correction path. Real decreases (un-reactions, deleted comments,
removed images) are also invisible by design. That's a deliberate trade-off, but the data
is "monotonic optimistic", not true, and a single bad datapoint permanently corrupts the
series.

### 1.4 No concurrency guard on the workflow
A slow quarterly run (thousands of images at 5-per-batch + rate-limit waits) can overlap
the next hourly run. Both read the gist, both write; last-write-wins and one snapshot
silently vanishes. Fix is one stanza in the workflow:

```yaml
concurrency:
  group: collect-stats
  cancel-in-progress: false
```

### 1.5 Delta-encode to save bytes… then pretty-print
`scripts/fetch-stats.js` (`updateGist`): `JSON.stringify(data, null, 2)` inflates the file
roughly 2–3×, largely undoing the delta-encoding savings. Dropping the indent is an
instant ~50–60% size cut with zero risk.

### 1.6 The "data integrity check" barely checks anything
`scripts/fetch-stats.js:1038-1073` asserts total image snapshots ≥ number of images —
i.e., one snapshot each. A merge bug that loses 90% of history passes. A real check would
compare against the pre-merge snapshot count (post-merge must be ≥ pre-merge minus what
retention legitimately removed).

### 1.7 Snapshot codec is triplicated
`resolveSnapshot` / `resolveAllSnapshots` / `isDelta` in the collector, plus a separate
`resolveSnapshots` with its own inline key list in `extension/stats-page/stats.js:97`.
Adding the next stat field requires touching ~5 places or resolution silently corrupts.
The `_d: 1` marker hack is a symptom that the format is fragile. Needs a single shared
codec module used by both sides.

## 2. Smaller defects

- `DEBUG = true` shipped on in `extension/content/content.js` — console spam on every
  click on civitai.com.
- `manifest.json` declares the `"scripting"` permission but nothing uses it. Web Store
  review flags unused permissions.
- Content script only matches `civitai.com` — no Stats menu item on `civitai.red`.
- Images with 0 reactions are re-fetched **every hour forever** (dead images included).
  They should demote to a slower tier after ~30 days at zero.
- Per-image refresh depends on the undocumented tRPC `image.get` endpoint — the biggest
  external risk; Civitai can change it without notice. (Known, but worth restating.)
- Every hourly gist update creates a git revision; the gist's underlying repo grows
  forever. Not urgent, but eventually heavy.
- **Privacy**: the public gist exposes prompt text (first 100 chars) for every image —
  including NSFW prompts — tied to a username. Users should be told; an extension-local
  mode (see §4) avoids it entirely.

## 3. Efficiency

- **Discovery is 8 full paginated sweeps per hour** (4 NSFW levels × 2 hosts), even
  though `sort=Newest` means each sweep could stop at the first page full of already-known
  IDs. Incremental discovery + a daily full sweep is the single biggest API-call
  reduction available.
- Fix the ×24 tier-day bug (§1.2).
- Stop hourly-refreshing permanently-zero images.
- Compact the JSON (§1.5); optionally move snapshots to positional arrays
  (`[t, dl, dh, ...]`) for another size cut.

## 4. Do we need GitHub Actions? Can this be shared without it?

**Not strictly, and for sharing it's the main obstacle.** Current onboarding: fork repo →
create gist → create PAT → set 3–5 secrets → enable Actions → sideload unpacked extension
→ paste raw URL. Developer-only. It also inherits Actions' failure modes (60-day cron
auto-disable, token expiry, transient 503s).

**Key insight: the stats are cumulative counters.** A gap in collection only costs
intra-gap resolution — never the totals. Therefore a 24/7 server is not required for the
numbers to stay correct.

**The extension can be the collector.** The service worker can run the same discovery +
tiered-refresh logic on `chrome.alarms` (every 30–60 min while the browser is open) and
store history in IndexedDB (`unlimitedStorage`). Extension fetches carry the user's
Civitai cookies, so it works with zero API keys and even sees the user's own hidden
images. The shareable product becomes: **install from the Chrome Web Store — done.** No
fork, no gist, no PAT, no Actions.

GitHub Actions then becomes the optional "24/7 fidelity" tier; gist sync becomes an
optional export/backup/multi-device feature.

**Important: the two modes coexist — this is not a replacement.** The existing Actions +
gist pipeline keeps running exactly as configured today, and the gist remains the owner's
authoritative 24/7 dataset. The extension simply gains a second data-source option:
*gist* (today's behavior, unchanged), *local* (in-browser collection for users who never
set up Actions), or both. An owner who already runs Actions loses nothing and changes
nothing.

Middle-ground alternatives for always-on collection without Actions: Cloudflare Worker
cron triggers (free tier suffices) or Windows Task Scheduler running the existing script.

## 5. Are the charts right?

Two questions here: are the charts *rendered correctly*, and are the chosen *chart types*
right for the shape of the data? Taking them in order.

### 5.1 Rendering correctness — two real problems

1. **The x-axis lies about time.** Charts use category labels (formatted date strings),
   not a time scale — but the data is *deliberately* unevenly spaced (hourly ≤7d,
   6-hourly ≤30d, daily beyond; per-image snapshots only exist on change). On "All", six
   months of daily points get the same pixel width as one week of hourly points. Fix:
   Chart.js time scale + a bundled date adapter. Highest-impact chart fix.
2. **"Gained per period" bars have irregular, undefined periods.** Change-only snapshots
   mean each bar spans "whatever gap happened to occur", so bar heights aren't
   comparable. Fix: bucket deltas into fixed calendar intervals (hour for 1d, day for
   30d/90d) — `dailyActivity()` already does this correctly for the Overview widget.

### 5.2 Chart *types* — view by view

The general mapping for this project's data shapes:

| Data shape | Right form |
|---|---|
| Trend of a cumulative counter over time | Line — ideally **stepped** line, since values only move at sample points |
| Amount gained per period | Bar; **stacked** bar when the total decomposes into types |
| Share-of-whole at one moment | Horizontal proportion bars (what you have — better than a pie) |
| Ranking ("top images") | Ranked horizontal bars |
| Intensity across a calendar | Heatmap (calendar or day-of-week × hour matrix) |
| Distribution across images | Histogram / Pareto |

Against that, each current view:

- **Trends tab, cumulative mode (multi-line)** — *right family, three refinements.*
  Line is correct for cumulative counters. But (a) with change-only snapshots, linear
  interpolation draws a steady slope across a 3-week silent gap, implying growth that
  didn't happen — a **stepped line** (`stepped: 'before'`) is the honest rendering for
  sparse counter data; (b) 8 toggleable series is spaghetti — default to Total +
  likes/hearts, rest opt-in; (c) on "All", early history is squashed flat by later
  totals — offer a log-scale toggle.
- **Trends tab, delta mode (grouped bars)** — *right type, wrong buckets* (see 5.1.2).
  Once buckets are fixed, a **stacked** bar of the four reaction types is strictly
  better than grouped bars + a separate "Total" series: the stack height *is* the
  total, and composition is visible in the same mark.
- **Reaction mix (proportion bars)** — *correct.* Horizontal labeled bars beat a pie for
  four close-valued categories. Optional upgrade: a 100%-stacked area over time to show
  how the mix *evolves*, which the single-moment bars can't.
- **Overview daily activity (14-day bar)** — *correct* for two weeks. Beyond ~a month,
  the right form is a **calendar heatmap** — bars stop being readable at 90+ columns.
- **Top movers (ranked rows with bar fill)** — *correct.* Ranked horizontal bars are
  exactly the form for "top N by gain".
- **Per-image charts (8-series line, hidden behind Show Chart)** — *overkill where it
  is.* The card-level question is "is this image moving?" — that's a **sparkline**
  (single total line, no axes) shown *always* on the card; the full multi-series chart
  belongs behind the expand for the rare deep-dive.
- **Summary cards (stat tiles + today/7d deltas)** — *correct*; a tiny 7-day sparkline
  inside each tile would add trend context at nearly zero cost.

What's already right and should not change: line for cumulative, bar for deltas,
auto-switching by range, delta clamping, no pie charts anywhere.

## 6. What else could be shown (data & fun)

Ranked roughly by delight-per-effort, from data already collected:

- **GitHub-style calendar heatmap** of reactions gained per day.
- **Best time to post** — day-of-week × hour heatmap. (See note on `analysis/` below.)
- **Personal records & milestones** — best day ever, gaining-streak, "10,000th like",
  progress bar + projected date to next round milestone.
- **Image velocity / half-life** — time to 50% of current total; "hidden gems" (old
  images still accelerating).
- **Distribution histogram** — reactions per image; "your top 5 images earned 60% of all
  reactions" (it's power-law shaped; people love this).
- **This week vs last week** comparison sparklines on summary cards.
- **Reaction personality per image** — laugh-ratio ("funniest"), heart-ratio ("most
  loved"), buzz-per-reaction ("most tipped").
- **"On this day"** — what you posted a year ago and what it earned since.

Needing modest extra collection:

- **Prompt/model/tag correlation** — `meta.prompt` is currently truncated to 100 chars at
  collection time; keep more (or a keyword set) to enable "images mentioning X average
  2.1× reactions".
- **"Your month on Civitai" recap card** exported as PNG — Wrapped-style, inherently
  shareable.

## Note on the `analysis/` folder

`analysis/` (analyze-posting-times.js, viewer.html, ~11k lines) originated in a
**different project**: a site-wide study of how reactions distribute across the week on
Civitai, not tied to one user.

**The folder stays in this repo — do not delete it.** It is valuable prior art for the
"best time to post" feature: its day-of-week × hour aggregation logic is exactly the
shape needed, fed by this project's own per-user snapshot deltas instead of site-wide
data. If it ever moves to its own repo, that's the owner's call, made separately.

## Bottom line

The collector logic is solid and battle-scarred in a good way. Fixable weaknesses: the
429-returns-undefined bug, the ×24 tier-day blowup, missing workflow concurrency, and the
non-time x-axis. The strategic move, if other users matter, is inverting the
architecture: **extension-local collection by default, GitHub Actions as an optional
power-user add-on** — the cumulative nature of the data makes this work with no real
loss.
