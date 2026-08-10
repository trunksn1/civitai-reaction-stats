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
| 1.5 | ✅ Policy-aware integrity check | Preserve the original hourly → six-hour → daily retention behavior. Before writing, require exact `before + added - retained-away = candidate` accounting, recompute required survivors with the shared retention policy, value-check every survivor, and preserve every image id and post-title key. Reject removals outside the policy. | M |
| 1.6 | ✅ Escape hatch for the ratchet | Add `RESET_IMAGE_IDS` env (comma-separated ids): for listed images, skip the `Math.max` clamp for one run so a corrupted inflated value can be corrected. Document in README troubleshooting. | M |
| 1.7 | ✅ Demote permanently-zero images | If an image has 0 total reactions **and** `createdAt` older than 30 days, refresh it on the monthly tier only (instead of hourly forever). | S |

## Phase 2 — Shared snapshot codec

| # | Task | Detail | Size |
|---|------|--------|------|
| 2.1 | ✅ Create `shared/snapshot-codec.js` | Single source of truth: `FIELDS` table (`likes↔dl`, `hearts↔dh`, …), `isDelta()`, `resolveAll()`, `resolveLast()`, `encodeAsDeltas()`, `computeDeltas()` (clamped). Plain ESM, no deps. | M |
| 2.2 | ✅ Use it in the collector | Replace `isDelta` / `resolveSnapshot` / `resolveAllSnapshots` / `encodeAsDeltas` in `fetch-stats.js`. `scripts/package.json` gets a relative import (or copy step). | M |
| 2.3 | ✅ Use it in the extension | Replace `resolveSnapshots`, inline delta detection and `computeDeltas` in `extension/stats-page/stats.js`. Extension has no bundler: include `shared/snapshot-codec.js` as a plain script before `stats.js` (expose a global) — keep it dual-mode (ESM export + `globalThis` fallback). | M |
| 2.4 | ✅ Codec tests | Add `scripts/test-codec.js` (plain node asserts, no framework): round-trip encode/decode, `_d` marker, zero-delta runs, unknown-key tolerance. Run in CI before collect. | M |

*Adding any future stat field then means one entry in `FIELDS`.*

## Phase 3 — Collector efficiency

| # | Task | Detail | Size |
|---|------|--------|------|
| 3.1 | ✅ Incremental discovery | Pass known image IDs (from existing gist data) into `fetchUserImagesFromHost`; stop paginating a level when a full page contains only known IDs. Force full sweep when tier ≠ daily or `FULL_DISCOVERY=true`. | M |
| 3.2 | ✅ Discovery telemetry | Log pages fetched per level/host before vs after (validates 3.1). | S |
| 3.3 | Versioned storage v2 | Gist size is now a measured concern: the deployed pretty JSON exceeded the inline API threshold, and compact branch output reached ~973 KB. Add `formatVersion`, read both formats, and use positional snapshot arrays or split history files. Preserve a verified pre-migration Gist clone and dry-run the conversion before writing. | L |

## Phase 4 — Chart correctness (extension)

| # | Task | Detail | Size |
|---|------|--------|------|
| 4.1 | ✅ Time-scale x-axis | Done via a plain `linear` scale over epoch-ms `{x, y}` points with a formatting tick callback — honest spacing with **no vendored date adapter needed**. | M |
| 4.2 | ✅ Fixed-interval delta buckets | Replace per-snapshot `computeDeltas` for bar charts with calendar bucketing (reuse/generalize `dailyActivity`): 1d → hourly buckets, 7d → 6h, 30d/90d → daily. Bars become comparable. | M |
| 4.3 | ✅ Stacked delta bars | In delta mode, render likes/hearts/laughs/cries as a stacked bar (stack = total); drop the separate "Total" series there. Keep "Total" as a line only in cumulative mode, default-off. | M |
| 4.4 | ✅ `civitai.red` support in extension | Add `https://civitai.red/*` to `host_permissions` + `content_scripts.matches` so the Stats menu also appears there. | S |
| 4.5 | ✅ Stepped-line cumulative mode | Render cumulative lines with `stepped: 'before'` so sparse change-only snapshots don't draw invented slopes across silent gaps. Add a log-scale toggle for the "All" range. | S |
| 4.6 | ✅ Declutter series defaults | Cumulative mode defaults to Total + likes + hearts visible; laughs/cries/buzz/collects opt-in. In stacked delta mode (4.3) hide the redundant Total series. | S |
| 4.7 | ✅ Card sparklines | Always-visible total-reactions sparkline (no axes) on each image card; the full multi-series chart stays behind the expand. (Summary-tile sparklines deferred.) | M |
| 4.8 | ✅ AoE2-style stacked timelines | Trends + per-image charts gain an "area" chart type (reaction types as stacked bands, always cumulative); Images tab gets a Reactions Timeline where each image is a colored band (top 12 by total + "Other"), resampled onto a common 120-point time grid. | M |

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
| 5.0 | Partial: authentication and endpoint probe | The Chrome identity/PKCE foundation, minimal scope `97`, `/userinfo`, rotating refresh-token persistence, `.com`/`.red` direct tRPC client, and both tRPC decoders are implemented for title write-back. A registered-client live probe must still prove the Chromium redirect plus DNR-adjusted Origin/Referer path; discovery and generation-data endpoints remain unproven for local collection. OAuth works on tRPC but not REST v1. | M |
| 5.1 | Storage layer | IndexedDB wrapper in the service worker (`extension/lib/db.js`): same logical schema as the gist JSON (meta, totalSnapshots, per-image snapshots). Add `unlimitedStorage` permission. | M |
| 5.2 | Port collector into service worker | New `extension/collector.js` reusing the codec + tier logic: discovery (incremental, both hosts), per-image tRPC refresh, clamping, retention. Use the credential/endpoint strategy proven in 5.0—prefer OAuth for tRPC, use an API key only where REST v1 remains necessary, and rely on cookies only if the extension-origin probe proves it robust. Rate limits: keep batch=5 / 300ms. | L |
| 5.3 | Scheduling | `chrome.alarms.create('collect', {periodInMinutes: 45})`; on fire, skip if last successful run < 30 min ago; catch-up run on browser startup. MV3 note: each alarm wakes the SW fresh — collector must checkpoint progress (per-phase) to survive SW termination on long runs. | M |
| 5.4 | Data-source abstraction | `stats.js` reads via one interface with two providers: `local` (IndexedDB) and `gist` (current behavior). Popup gets a source selector: "Collect locally (default)" / "Read from Gist URL". | M |
| 5.5 | Partial: onboarding | Popup OAuth connection is implemented: it displays the exact redirect, accepts only a public client ID, runs Authorization Code + PKCE, identifies the account through `/userinfo`, protects tokens in extension-local storage, serializes refreshes, and supports local disconnect. First-run onboarding and starting a local collection remain part of the future extension-first mode. | M |
| 5.6 | Import/export | Export local DB as `stats.json` (same schema — the collector's format is the interchange format); import an existing gist file to keep history when migrating from the Actions setup. | M |
| 5.7 | Web Store packaging | Icons/screenshots, privacy policy (all data local; nothing leaves the browser in local mode — also fixes the public-prompt privacy issue), zip pipeline, submit. | M |
| 5.8 | Docs rewrite | README: "Install extension" as the primary path; GitHub Actions + gist demoted to an optional "24/7 collection" appendix for power users. | M |

*Non-goal: removing the Actions path. It stays as the high-fidelity option and as the
multi-device sync backend (extension can keep reading the gist).*

## Phase 6 — New visualizations & fun (after 4 + 5.1)

Ordered by delight-per-effort; each is an independent widget on the Overview tab.

| # | Feature | Data source | Size |
|---|---------|-------------|------|
| 6.1 | ✅ Calendar heatmap (GitHub-style; switchable reactions, net followers, images, or posts; 12 months) | existing total and creator snapshots | M |
| 6.2 | Split timing views: (a) audience-activity DoW × hour heatmap from reaction inflow; (b) true personal “best time to post” using publish time versus age-normalized image outcome/velocity with sample-size warnings. The former must not be labeled as evidence for the latter. | existing snapshots + `createdAt` | M |
| 6.3 | 🟡 Records & milestones — best day/week, gaining streak, next round-number milestone, top post, oldest image still gaining are done; projection ETA remains intentionally deferred until enough stable daily data exists | existing | M |
| 6.4 | ✅ Distribution histogram + "top N images = X% of reactions" | existing | S |
| 6.5 | Week-vs-last-week sparklines on summary cards | existing | S |
| 6.6 | 🟡 Oldest-image-still-gaining and new-work-vs-back-catalog are done; full velocity/half-life scoring remains | existing | M |
| 6.7 | ✅ Reaction personality (funniest / most loved / most tipped) | existing | S |
| 6.8 | ✅ "On this day" (posted a year ago + earned since) | existing | S |
| 6.9 | Monthly recap card exported as PNG (canvas-rendered, Wrapped-style) | existing | L |
| 6.10 | Prompt/keyword performance correlation — conditionally unblocked by OAuth tRPC `image.getGenerationData`; store only an opt-in local keyword representation, not raw prompts in the public Gist | Phase 5 OAuth + local storage + UI | L |

## Phase 7 — Real image names (post titles, write-back)

*Goal: stop showing `Image 114507519` everywhere. Derive a human name from the post
title, and let the rename box actually write that title back to Civitai.*

### 7.0 Findings that shape this phase (measured 2026-07-29, account `JeneScript`)

Sample: 744 images / 458 posts pulled from the public REST API across all four NSFW
levels, spanning 2024-01-15 → 2026-07-28.

| Question | Measured answer |
|---|---|
| Is `postId` available? | **Yes, 744/744.** Already in the REST response the collector reads — it is simply discarded today. Free to store. |
| Do posts have titles? | **~7%.** 2/30 in an evenly time-spread sample, 1/25 in a recent-only sample. Not a recency effect — untitled is the norm across all 2.5 years. |
| Is the original filename available? | **No — 0/744.** Every CDN URL's last segment is the image UUID (`ae4c3921-…-1a57628ae436.jpeg`). Confirmed on 200 other-user images too. The public API exposes no filename field. |
| Why is everything numeric today? | **`meta` is `null` on 744/744 images.** `name` in `fetch-stats.js:843` is `img.meta?.prompt?.substring(0,100) || 'Image ' + id`, so the fallback fires 100% of the time. |
| Multi-image posts? | **128/458 posts (28%)**, up to 10 images each, mean 1.62 images/post. |
| Usable fallback signal? | **`baseModel`, 733/744 (98.5%)** — `SD 1.5`, `OpenAI`, `Krea 2`, `Nano Banana`, `Illustrious`, … |

**Consequences for the original feature request:**

1. **The filename fallback is dead — settled 2026-07-29, see 7.1.** Not available publicly,
   and not available from the authenticated download route either. There is no filename
   rung. Drop it and stop looking.
2. **Post titles alone fix only ~7% of names.** Reading titles is worth doing, but on its
   own it leaves ~93% of images still called `Image <id>`. Hence 7.4 (a better fallback)
   is not optional polish — without it the phase is barely visible.
3. **`pt. N` is extension-only by design** (owner decision, 2026-07-29 — matches the
   platform anyway). A post has exactly one `title` shared by all its images, and images
   have no title of their own. So: **Civitai receives the plain title the user typed, with
   no suffix.** The `— pt. 1` / `— pt. 2` numbering is a display convention that exists
   only in the extension, applied when the user opts to spread the name across the post.
   Nothing is lost here — the write is what the user wants written.
4. **Write-back inverts the value of the feature.** Because only 7% of posts are titled,
   the rename box pushing titles *to* Civitai is the thing that makes titles exist. The
   owner does not title posts today because there is no payoff in the Civitai UI; this
   feature *is* the payoff, and it improves the public post pages, not just this extension.
   That makes 7.7 the point of the phase rather than a nice-to-have.

Also invalidated by the `meta: null` finding: **item 6.10** (prompt/keyword correlation)
has no data source on this account. Leave it listed, but it is blocked, not merely large.

### 7.1 Gate: does the authenticated download carry a real filename? — ❌ **ANSWERED: NO**

*Closed 2026-07-29. No work to do; kept as the record of why there is no filename rung.*

Run logged in as the image owner, on `civitai.com`:

```js
const r = await fetch('/api/download/images/114507519', { credentials: 'include' });
console.log(r.headers.get('content-disposition'), r.url);
```

**Result: `404 Not Found`** — on the owner's own image, while authenticated. (Unauthenticated,
the same URL 307-redirects to login, so the route exists but serves nothing for images.)
Combined with the URL evidence — the CDN path's final segment is the image UUID on 744/744
own images and 200/200 sampled others — the conclusion is:

> **Civitai does not retain or expose the uploaded filename.** What a browser saves when you
> download an image is the UUID from the CDN URL, which is why nothing anywhere returns
> `bingo bango bongo.png`.

**Do not re-investigate this** without new evidence (e.g. an actual download that lands with
a human filename — if that ever happens, capture the exact request from DevTools first).
Task 7.5 is deleted, not deferred; 7.4's `baseModel · date` rung carries the fallback.

### 7.2 ✅ Collector: store `postId` **[S]**

`scripts/fetch-stats.js` — add `postId: img.postId ?? null` to the object returned by
`processImages` (~line 841) and carry it through the two synthesis paths that rebuild
image records (`fetchAllUserImages` incremental-synthesis, and the missing-image
carry-forward in `processImages`) so it is not lost on non-sweep runs. No schema version
bump needed: absent `postId` simply means "not yet collected".

### 7.3 ✅ Collector: fetch post titles, budgeted and resumable **[M]**

No public REST posts endpoint exists (`/api/v1/posts` → 404) and unauthenticated tRPC
`post.get` now returns `401 "Please use the public API instead"`. The one working public
read is the post page's embedded Next.js payload:

```
GET https://civitai.com/posts/{postId}
→ <script id="__NEXT_DATA__">
→ props.pageProps.trpcState.json.queries[] → find the entry whose state.data.id === postId
→ .title            (null when untitled)
```

Match the query by `state.data.id`, **not** by array index — index 0 was the site-wide
announcement banner on one of the two pages sampled.

Constraints to respect:
- ~110 KB per page fetch. A full backfill of ~6,500 posts (16k images at 1.62/post) is
  ~700 MB and ~55 min at 500 ms spacing — too much for one hourly run.
- So: **budget per run** (e.g. `POST_TITLE_BUDGET`, default 150) and persist a
  `postTitles: { [postId]: { title, fetchedAt } }` map in the gist. Each run resolves
  only posts absent from that map, newest-first, until the budget is spent. Backfill
  completes over a couple of days and then costs only new posts per run.
- Re-check titles on the monthly tier only (titles change rarely, and 7.7 writes them
  through the same map anyway).
- Best-effort throughout: a failed page fetch must never abort the run, matching the
  existing `.red` discovery posture.

### 7.4 ✅ Naming cascade **[M]**

Replace the `displayName()` in `extension/stats-page/stats.js:1437`. Resolution order:

1. User's local custom name (existing `customImageNames`) — always wins.
2. Post title, when present. Multi-image post → append ` — pt. N` **for display only**,
   where **N is the rank of the image id ascending within the post**. Sorting by id is
   verified necessary: in post `1331368` the `createdAt` ordering contradicts id ordering,
   and in post `29264269` all four images share one timestamp — `createdAt` is not a
   stable sort key.
3. `baseModel` + posted date, e.g. `SD 1.5 · 15 Jan 2024` — covers 98.5% and is genuinely
   more informative than the id. Requires storing `baseModel` alongside `postId` in 7.2.
4. `Image {id}` — final fallback, now rare.

*(The filename rung the original request assumed would sit at #3 does not exist — see 7.1.)*

**Truncation — deliberately not implemented. Reverse this if you disagree.**

The original request asked for a 15-character cut with `…`. That rule was specified *for
filenames* ("bingo bango bongo.png"), and filenames turned out not to exist (7.1). Applying
it to the rungs that do exist would be destructive rather than tidy:

| Real value | At 15 chars |
|---|---|
| `Various Models - clipskip differences` | `Various Models…` |
| `Tiger and axolotl, Prompt on Canvas` | `Tiger and axolo…` |
| `SD 1.5 · Jan 15, 2024` | `SD 1.5 · Jan 15…` |

Post titles are the whole point of the feature, and 15 characters throws most of one away.
Names are instead left full-length and clipped by CSS, which already ellipsizes at whatever
width the card actually has — and the full name plus its origin is in the hover tooltip.
Chart labels keep their existing 28-char cut.

If a hard cap is still wanted, apply it to the base name **before** the ` — pt. N` suffix
so the part number is never what gets truncated away.

### 7.5 ~~Filename capture~~ — **deleted**

Removed 2026-07-29: 7.1 proved there is no filename to capture. Intentionally left as a
numbered stub so 7.6/7.7 references in older notes still line up.

### 7.6 ✅ Rename UI: local name vs. post title **[M]**

**Implemented 2026-08-10:** the dialog now separates local image/post scope from the
independent public-title checkbox. Derived `pt. N` names remain local; Civitai receives
only the plain title.

Extend the existing inline editor (`startRename`, `stats.js:1446`). Two independent things
happen on save, and the dialog must keep them visually separate:

- **What Civitai gets:** the plain title the user typed. No `pt. N`, ever. One title per
  post, which is all Civitai stores.
- **What the extension shows:** either just this image renamed, or the whole post's images
  renamed with `— pt. 1..N` numbering.

Flow:

- **Single-image post** → rename the image; offer "Also set this as the post title on
  Civitai?" as a checkbox. No numbering involved.
- **Multi-image post (N images)** → after the name is entered, ask how it should apply
  *in the extension*:
  - **Use for all N images in this post** — they display `Title — pt. 1` … `Title — pt. N`.
  - **Just this image** — only this card takes the name; siblings keep their existing names.
  - Independently, the "Also set as the post title on Civitai" checkbox writes the plain
    title. Both branches can push it — the choice above is purely about local display,
    so make the checkbox's label say "the post title" and not "this name".
- Renames stay in `chrome.storage.local` exactly as today; write-back is opt-in per action.
  A local name is never silently pushed.
- Expanding `pt. N` names into storage: write them as *derived* (store the base name +
  the "spread across post" flag), not as N literal strings. Otherwise adding an image to
  the post later leaves the numbering stale and unfixable.

### 7.7 🟡 Write-back to Civitai **[L]** — independent OAuth implemented; live owner probe required

The signed-in-tab relay has been replaced by a fully independent OAuth/PKCE path.
It requests only scope `97`, stores rotating tokens in protected extension-local
storage, applies narrowly scoped temporary Origin/Referer rules for direct Civitai
tRPC calls, and supports both `.com` and `.red`. The narrow `{ id, title }`
mutation, authoritative conflict check, post-write re-read, cached-title update,
harmless failure path, and one-step undo for an existing non-empty title are
implemented. No open Civitai tab or session cookie is used.

Do not mark this fully shipped until the owner registers the popup's exact
Chromium redirect URL, completes consent, and tests a disposable title on the
real deployed tRPC path. No automated test should mutate a real public post.
Current Civitai service code ignores null/empty titles, so the extension refuses
public clearing and cannot promise undo-to-untitled.

Mutating the user's live account. Requirements:

- **Probe OAuth `post.update` live.** The code path is present, but the registered
  extension must still exercise a throwaway title and restore a non-empty original.
  The extension deliberately has no cookie-relay fallback: OAuth failure is loud and
  harmless instead of silently depending on browser login state.
- **Verify the mutation shape by observation first.** Rename a post in the Civitai UI with
  DevTools open, capture the exact `post.update` request (input envelope, whether a CSRF
  header rides along, whether omitted fields are treated as cleared), and mirror it. Do
  **not** guess the payload — a partial update could blank a post's description.
- **Confirm before the first write** and surface the server's response. Re-read the post
  page (7.3) after writing to confirm the title actually changed, and update the cached
  `postTitles` entry on success.
- **Undo**: keep the previous title in local storage so a bad rename can be reverted.
- tRPC is undocumented and has already tightened once (the 401 above) — treat write-back
  as breakable-by-upstream, keep it behind a setting, and fail loudly but harmlessly.

### 7.8 ✅ Docs **[S]**

Keep the 7.0 findings in this plan and the checked-in
`CIVITAI_OAUTH_INTEGRATION_GUIDE.md` (filename absence, title routes, auth behavior,
and tRPC wire formats), and note in `README.md` that names come from post titles with
a local-override layer.

### Suggested order

`7.2` → `7.3` → `7.4` → `7.6` → `7.7`. (`7.1` is answered; `7.5` is deleted.)
**7.2 + 7.3 + 7.4 alone are shippable** and deliver readable names for titled posts plus a
decent fallback for the rest; 7.6/7.7 add the write-back that makes titles exist in the
first place — which, for an owner who has no reason to title posts in the Civitai UI, is
the actual point of the phase.

---

### ✅ Side finding — RESOLVED 2026-07-29: collector tRPC access is healthy

*Kept as the record of how this was ruled out. **No action needed.***

The worry was that Civitai's tRPC lockdown had silently killed buzz/collects collection.
It has not. Three pieces of evidence, together conclusive:

1. **The 401 is anonymous-only, and it is a real HTTP 401** (not a 200 carrying an error
   body). That matters: `fetchWithRetry` throws on a non-ok response, so a rejected key
   would produce one `Warning: Failed to fetch stats for image` line per image.
2. **The 2026-07-29 run logged zero such warnings** across its 182-image refresh.
3. **Buzz went 0 → 8712 and collects 0 → 2091 between the 2026-02-08 and 2026-07-29 runs.**
   Neither field has any REST source — `image.get` is the only place they come from. They
   could not have grown unless the key was being accepted.

Conclusion: `CIVITAI_API_KEY` is honoured on tRPC. Only unauthenticated callers get the
"Please use the public API instead" 401.

**Two consequences for this phase:**

- **7.3 should try tRPC `post.get` with the API key first**, and fall back to HTML scraping
  only if that 401s. A tRPC call is a few hundred bytes against ~110 KB for a post page —
  roughly a 100× saving on the backfill, which turns a multi-day drip into a single run.
- 7.7 now uses an independent OAuth bearer grant rather than the scheduled collector's
  API key or a session cookie. Source and unit-level wire checks pass; a registered
  extension must still complete the disposable live mutation probe.

<details>
<summary>Original concern (superseded)</summary>

How the collector gets its numbers today, in two steps:

| Step | Endpoint | What it yields |
|---|---|---|
| Bulk discovery | REST `/api/v1/images?username=…` | likes, hearts, laughs, cries, comments — but **stale**, and no buzz/collects/views |
| Per-image refresh | **tRPC** `image.get` | the accurate numbers, and the *only* source of **buzz, collects, views** |

So every buzz and collect figure in the extension comes from tRPC, one call per image.

**What changed:** as of 2026-07-29, calling tRPC `image.get` without credentials returns
`401 UNAUTHORIZED — "Please use the public API instead"`. Civitai appears to have closed
tRPC to outside callers. The collector authenticates with `CIVITAI_API_KEY`, and whether
a Bearer key is still accepted **could not be tested** (the key is a GitHub secret).

**Why it would be silent.** `fetchImageStats` wraps the call in a try/catch that logs a
warning and returns `null` (`fetch-stats.js:154-157`). On `null`, `refreshImageStats`
counts the image as "unchanged" and moves on. The run then completes, passes its integrity
check, and updates the gist as usual. On top of that, the never-decrease clamp means the
old buzz/collect values are carried forward rather than dropping to zero — so the charts
would show **flat lines**, not a crash. Nothing anywhere goes red.

**How to check — in order of effort:**

1. Open the latest `Collect Civitai Stats` Actions run and search the log for
   `Warning: Failed to fetch stats for image`. A handful is normal noise; hundreds or
   thousands means tRPC is rejecting the key.
2. In the extension, pick an image you know has recently received tips or collects and see
   whether its buzz/collects have moved at all in the last weeks while likes kept rising.
3. Definitive, from the browser, **logged in on `civitai.com`** (this also tells us whether
   7.7's write-back path is viable, since it proves tRPC works from a session):

   ```js
   const input = encodeURIComponent(JSON.stringify({ json: { id: 114507519 } }));
   const r = await fetch(`/api/trpc/image.get?input=${input}`, { credentials: 'include' });
   console.log(r.status, JSON.stringify((await r.json())?.result?.data?.json?.stats));
   ```

   Stats object → tRPC still works from a logged-in session (good news for 7.7).
   `401` → tRPC is closed to everyone and **7.7 must be rebuilt** around the post *editor
   form* rather than a tRPC mutation.

**If the key is being rejected**, the fix is a separate task from Phase 7: either restore a
working credential, or fall back to REST-only collection and accept that buzz/collects
freeze (they have no REST source at all). Decide before building 7.7, because 7.7 assumes
tRPC mutations work.

</details>

---

### Unresolved / needs a decision

1. Gist size is **measured and active**, not hypothetical. A deployed run wrote ~1.44 MB
   pretty JSON and used the `raw_url` truncation fallback; compact branch output was
   ~973 KB. Complete 3.3 before growth makes every extension load unnecessarily heavy.
2. Should a local rename that was *not* pushed still be exported/synced across devices?
   Currently `chrome.storage.local` is per-device by design.
3. When the user later edits a post title on Civitai directly, the cached `postTitles`
   entry goes stale until the monthly re-check. Acceptable, or force a re-read of any post
   the extension has written to?

## Suggested order & dependencies

```
Phase 0 ─┐
Phase 1 ─┼─► Phase 2 (codec) ─► Phase 3 (efficiency)
         │                    └► Phase 5 (extension-first) ─► Phase 6
         └─► Phase 4 (charts, independent) ──────────────────┘

Phase 7 (names) — needs only 7.1's answer to start; independent of 2–6.
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

4. **Phase 5 credential mix** — can tRPC-only OAuth cover discovery well enough to avoid
   asking ordinary extension users for an API key, or is a limited REST/API-key path still
   required? Settle with the 5.0 probe, not assumptions about browser cookies.

~~4. `analysis/` destination~~ — **resolved: it stays in this repo, untouched** (owner
decision, 2026-07-28).
