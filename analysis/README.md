# Best Time to Post — Civitai posting-time analysis

A standalone, for-fun analysis that asks: **does *when* you post to Civitai correlate with how many reactions an image ends up with?** It pulls the most-reacted images across the platform, looks at the day-of-week / hour-of-day they were posted, and compares that against when images are posted *in general* — so the result reflects genuine advantage, not just upload volume.

This is separate from the main project (which tracks *your own* images over time). It lives entirely in this `analysis/` folder and needs no build step or dependencies — just Node 18+.

## TL;DR

```bash
# 1. See it work immediately with synthetic data (no network):
node analyze-posting-times.js --sample
open viewer.html            # or just double-click it

# 2. Run the real pull (needs civitai.com access — see "Where to run" below):
CIVITAI_API_KEY=xxx node analyze-posting-times.js
#    → writes posting-analysis.json
#    → load that file in viewer.html (Choose File / drag-drop), or serve over http
```

## What it measures (and the one statistical gotcha)

The naive version — "chart when the top images were posted" — is **misleading**. If 40% of *all* uploads happen at 18:00 UTC, then ~40% of the top images do too. That's volume, not advantage.

So we compute **lift**:

```
lift(day, hour) = (top images' share of that cell) ÷ (all uploads' share of that cell)
```

- **lift > 1** → that day/hour *over-performs*: top images land there more often than raw posting volume would predict. This is the honest "good time to post" signal.
- **lift < 1** → *under-performs*.

The viewer's **Lift vs. baseline** mode shows this (red = over, blue = under). The **Top volume** and **Baseline** modes show the raw counts behind it.

## How the data is collected (and why it's done this way)

The public Civitai API (`GET /api/v1/images`) has two constraints that shape everything:

1. **No calendar-year / date-range filter, and `period` is a *rolling* window** (`period=Year` = last 365 days, not "2023"). So to slice by calendar year we deep-paginate `sort=Most Reactions&period=AllTime` **once** and bucket every image by its `createdAt` year locally. Because we walk in reaction order, the first `PER_YEAR` images we see for any year *are* that year's most-reacted. Quiet years fill more slowly — raise `MAX_PAGES` to give them fuller coverage. The viewer's **Coverage** column shows `full` (hit the cap) vs `partial` (ran out of pages first).

2. **A true per-year baseline is infeasible** (it would mean paginating millions of `Newest` images back through each year). Instead we page recent `Newest` uploads until they **span a full week+** (`BASELINE_DAYS`, default 9), giving the day-of-week / hour-of-day *rhythm*, and reuse that across all years. **This span matters:** Civitai's upload volume is huge, so a fixed *count* of recent images only covers ~1 day — which leaves the lift heatmap blank on every weekday the run didn't touch. Spanning by *days* guarantees all seven weekdays are represented. **Assumption:** the *shape* of when people upload (evenings, weekends, etc.) is roughly stable over time, even though total volume rose and fell.

All times are **UTC**. The viewer has a timezone-offset selector so you can shift the grid to a local audience.

The reaction metric is `likes + hearts + laughs + cries` — the same definition the main collector (`scripts/fetch-stats.js`) uses.

## Where to run the live fetch

The fetch needs outbound access to `civitai.com`. Good options:

- **Locally** — just run the command above on your machine.
- **GitHub Actions** — the same place the main collector runs. Add a manually-triggered workflow that runs `node analysis/analyze-posting-times.js` and uploads `posting-analysis.json` as an artifact (or commits it). The existing `CIVITAI_API_KEY` secret works as-is.

(It will *not* run inside Claude Code's web sandbox — that environment's network policy blocks civitai.com.)

## Tuning

All optional, via env vars:

| Var | Default | Meaning |
|-----|---------|---------|
| `PER_YEAR` | `5000` | Top images kept per calendar year |
| `MAX_PAGES` | `300` | Max pages (×200 imgs) per NSFW level for the top pull. Raise for fuller coverage of quiet years. |
| `BASELINE_DAYS` | `9` | How many days of recent uploads the baseline must span (≥7 so every weekday is covered) |
| `BASELINE_MAX_PAGES` | `200` | Per-nsfw-level page cap for the baseline pull (safety) |
| `NSFW_LEVELS` | `None,Soft,Mature,X` | Which content tiers to include (the API returns them separately) |
| `PAGE_DELAY_MS` | `500` | Politeness delay between page requests |
| `CIVITAI_API_KEY` | — | Optional bearer token; higher rate limits |
| `OUT` | `posting-analysis.json` | Output path |
| `RAW_OUT` | — | If set, also dumps the raw collected images so you can re-analyze without re-fetching (`--in <file>`) |

### Rough cost

5000/year × ~5 years from a single reaction-sorted stream, plus a 20k baseline, is roughly a few hundred page requests at 0.5s each — minutes, not hours. Deep coverage of very quiet years costs more pages (that's what `MAX_PAGES` caps).

## Files

- `analyze-posting-times.js` — collector + analyzer. `--sample` (synthetic, no network), `--in <raw.json>` (re-analyze a saved dump — instant, no API), or no args (live fetch).
- `viewer.html` — self-contained viewer (no external libraries/CDN), with two tabs:
  - **⏰ When to post** — the day×hour heatmap (lift / top-volume / baseline modes), plus best-hour-of-day and best-day-of-week lift bar charts, a "best slot" summary, year selector and timezone shift.
  - **📊 The data (years & months)** — a month-by-month timeline across all years (the boom/decline, by count or median reactions), the selected year's per-month breakdown, a reaction-size distribution histogram, and the year-over-year table.

  Ships with embedded synthetic data so it renders on first open; load real data via the file picker or drag-drop, or serve the folder over http so it auto-loads `posting-analysis.json`.

### Re-running vs. recomputing

A live fetch always writes **two** files:
- `posting-analysis.json` — the computed views (what the viewer loads).
- `posting-raw.json` — the slim raw data (just `createdAt` + reaction count per image).

If you later want a different view or tweak, you do **not** need to hit the API again — recompute instantly from the raw dump:

```bash
node analyze-posting-times.js --in posting-raw.json
```

(Changing `PER_YEAR` etc. and re-running `--in` recomputes from whatever was already collected.)

## Caveats worth remembering

- **Survivorship**: we only look at top images. Lift-vs-baseline controls for posting volume, but it can't tell you *why* a slot over-performs (more engaged audience online? algorithmic surfacing? coincidence at small N).
- **Reaction accrual time**: older images had longer to accumulate reactions. This affects cross-*year* magnitude comparisons (the year-over-year table), not the within-year day/hour pattern.
- **Baseline stability** is an assumption (see above), not a measurement.
- **Synthetic sample is fake.** The numbers you see before running a live fetch are randomly generated to demonstrate the UI, with a planted "Tue–Thu afternoon over-performs" pattern.
