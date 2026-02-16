# Rollback instructions

## What was changed (2026-02-16)

Merged branch `fix/false-reaction-spikes` into main to fix false spikes in the "Reactions Gained" chart caused by the Civitai API intermittently dropping images from responses.

Commit before the merge: `2b8e87f` ("numeri ora giusti")

## How to rollback

```bash
git reset --hard 2b8e87f
git push --force origin main
```

This restores main to exactly how it was before the fix.
