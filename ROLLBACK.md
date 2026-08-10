# Rollback and data-recovery guide

The Git repository and the collected statistics are separate systems:

- Application code lives in this GitHub repository.
- Historical statistics live in the public Gist's `stats.json` and its Git
  revision history.

Rolling back code must never require deleting or resetting the statistics.

## Before deploying collector changes

1. Run the branch workflow manually with **dry-run enabled**. This reads and
   validates the live dataset but skips the Gist update.
2. Download the resulting `civitai-stats-dry-run-*` Actions artifact. It contains
   `stats-before.json` and `stats-candidate.json` for comparison.
3. Clone the Gist to a directory outside this repository to preserve all Gist
   revisions:

   ```bash
   gh gist clone YOUR_GIST_ID /path/outside/the/repository/pre-deploy-gist-backup
   git -C /path/outside/the/repository/pre-deploy-gist-backup fsck --full
   ```

4. Confirm that the backup's `stats.json` parses and record its SHA-256 hash:

   ```bash
   cd scripts
   npm run validate:stats -- /path/to/pre-deploy-gist-backup/stats.json
   ```

## Roll back application code

Revert the merge through normal Git history; do not reset or force-push `main`.

```bash
git switch main
git pull --ff-only
git revert -m 1 MERGE_COMMIT_SHA   # use -m 1 only when reverting a merge commit
git push origin main
```

If the PR was squash-merged, use `git revert SQUASH_COMMIT_SHA` without `-m`.
Open a PR for the revert when branch protection or review policy requires it.

This changes only application code. It does not delete or rewrite the Gist.

## Recover historical statistics

Use this only if a collector run wrote a bad candidate despite the safety
checks.

1. Disable or pause the scheduled collector so it cannot overwrite the recovery.
2. Open the stats Gist on GitHub and inspect **Revisions**.
3. Choose the last known-good revision and compare its timestamp, image count,
   total snapshot count, and SHA-256 hash with the pre-deploy backup/artifact.
4. Restore that revision's complete `stats.json` content as a new Gist revision.
   Never replace it with `{}` and never reconstruct it from only the latest
   counters; the per-image snapshot arrays are the historical record.
5. Run the collector in dry-run mode and verify the candidate before re-enabling
   scheduled writes.

The Gist's old revisions and an independent full-history clone provide two
recovery paths. Keep at least one verified clone outside the application repo.

## Historical note

The old rollback instructions pointed to commit `2b8e87f` and recommended
`git reset --hard` followed by a force-push. They were removed because rewriting
shared `main` history is unnecessary and can discard unrelated work. Use a
revert instead.
