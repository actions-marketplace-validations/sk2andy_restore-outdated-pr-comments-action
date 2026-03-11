# Restore Outdated PR Comments Action

Recreate outdated pull request review threads on the current diff and keep the reply structure intact.

When a pull request author changes a previously reviewed line, GitHub marks the original review thread as outdated. This action scans those outdated threads after each PR update, tries to re-anchor them on the current diff, recreates the root comment plus replies, and deletes the old outdated thread only after the full recreation succeeds.

## What it preserves

- The review thread structure
- The original author name above each restored comment
- A link to the original comment on the restored root comment
- A collapsible original diff hunk on the restored root comment when GitHub exposes the old `diffHunk`

## What it does not do

- It cannot embed GitHub's native historical inline diff UI inside a comment.
- If a thread can no longer be cleanly anchored to the current diff, it leaves that thread untouched and outdated.

## Usage

Add the action to a workflow that runs after PR updates:

```yaml
name: Restore outdated review comments

on:
  pull_request:
    types: [synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  restore:
    runs-on: ubuntu-latest
    steps:
      - uses: sk2andy/restore-outdated-pr-comments-action@v1
        with:
          github-token: ${{ github.token }}
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | Yes | - | Token with permission to write PR review comments |
| `wait-seconds` | No | `15` | Seconds to wait before scanning outdated review threads |
| `repository` | No | `GITHUB_REPOSITORY` | Optional `owner/repo` override |
| `pull-request-number` | No | current PR event | Optional PR number override |
| `locale` | No | `en-US` | Locale for the restored "Originally by" timestamp |
| `time-zone` | No | `UTC` | Time zone for the restored "Originally by" timestamp |
| `include-diff-context` | No | `true` | Include the original diff hunk on the restored root comment when available |

## Notes

- The action is designed for pull request events.
- The root comment is recreated first, then replies are recreated as replies to that new root comment.
- Old comments are deleted only after the new thread is fully rebuilt.

## Development

Run the local checks with:

```bash
node --check src/index.mjs
node --test test/index.test.mjs
```

## License

MIT
