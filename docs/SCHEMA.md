# `.branch-review/` schema (v1)

## `config.json`

```json
{
  "baseBranch": "main",
  "reviewBranch": "feat/my-branch"
}
```

`reviewBranch` is the branch whose commits you inspect. The app reads that ref; it does not check out or change the branch on disk.

## `comments/<branch-slug>.json`

```json
{
  "version": 1,
  "branch": "feat/my-branch",
  "baseBranch": "main",
  "updatedAt": "2026-09-17T20:00:00.000Z",
  "comments": [],
  "messageEdits": {},
  "reviewedShas": []
}
```

### Line comment

```json
{
  "id": "cmt_01HZX...",
  "kind": "line",
  "commitSha": "abc1234def5678...",
  "path": "src/foo.ts",
  "startLine": 42,
  "line": 45,
  "lineType": "added",
  "snippet": "  return items.reduce(...)\n    .filter(Boolean)\n    .map(toRow)",
  "body": "Prefer a plain for-loop here.",
  "createdAt": "2026-09-17T20:01:00.000Z"
}
```

`lineType` is `added` | `removed` | `unchanged`.

`line` is the last line of the range (inclusive). The comment thread is shown under that line. Optional `startLine` is the first line (inclusive). Omit `startLine` for a single-line comment. When set, `startLine` must be `<= line`, and every line in the range shares the same `lineType` side.

`snippet` is included when the covered line text is non-empty after trim; omitted for blank lines. For a multi-line range, `snippet` is the joined line texts (newline-separated).

| `lineType` | `line` / `startLine` refer to |
| --- | --- |
| `added` | New file (post-image) |
| `unchanged` | New file (post-image) |
| `removed` | Old file (pre-image) |

### File comment

```json
{
  "id": "cmt_01HZZ...",
  "kind": "file",
  "commitSha": "abc1234def5678...",
  "path": "src/foo.ts",
  "body": "This file should not own this responsibility.",
  "createdAt": "2026-09-17T20:02:00.000Z"
}
```

No `line`, `lineType`, or `snippet` on file comments.

### Commit comment

```json
{
  "id": "cmt_01HZY...",
  "kind": "commit",
  "commitSha": "abc1234def5678...",
  "body": "Subject should say why, not what.",
  "createdAt": "2026-09-17T20:03:00.000Z"
}
```

No `path`, `line`, `lineType`, or `snippet` on commit comments.

### Whole-branch review comments

Any comment kind may include `diffBaseSha`, the full SHA of the merge base used
for the reviewed diff. In that case, `commitSha` must be the full branch-tip SHA
at review time. Together they identify an immutable diff snapshot. A `commit`
comment with `diffBaseSha` refers to the whole branch diff.

Comments without `diffBaseSha` retain their original single-commit meaning.
The UI shows comments inline only for their matching snapshot; comments from
older branch snapshots appear separately. MCP uses the stored pair of SHAs to
retrieve the original context, even after the branch advances.

### Resolved comments

Optional on any comment kind. When addressed, keep the comment and mark it
resolved instead of deleting it.

```json
{
  "resolved": true,
  "resolvedAt": "2026-09-17T21:00:00.000Z"
}
```

- Omit `resolved` / `resolvedAt` (or set `resolved` to `false`) for open comments.
- Apply mode must set these fields after a successful fix; do not remove the comment object.
- Hard delete remains available for mistakes only.

### Comments sent to an agent

Optional on any comment kind. Set when the reviewer hands the comment to an
agent with the sparkle button, or by an MCP client writing the same fields.

```json
{
  "dispatched": true,
  "dispatchedAt": "2026-09-17T21:05:00.000Z"
}
```

- Omit `dispatched` / `dispatchedAt` (or set `dispatched` to `false`) when the comment has not been sent.
- Taking the comment back clears both fields.
- Resolving keeps them, so the record shows an agent handled it.
- `dispatched` and `resolved` are independent. An agent's queue is the comments where `dispatched` is true and `resolved` is not.

### Message edits

Optional map of commit SHA → overlay for the subject and/or body. Missing keys use the git commit text. Does not rewrite git history.

```json
{
  "messageEdits": {
    "abc1234def5678...": {
      "subject": "feat(api): clarify filter error path",
      "body": "Keep the public error shape stable."
    }
  }
}
```

- Omit `subject` or `body` when that field is not overridden.
- An empty `body` string means the description is intentionally blank.
- Remove the SHA entry (or the field) to reset to git.

### Reviewed commits

Optional list of full commit SHAs the reviewer marked as reviewed. Local progress only; does not block Apply and does not require comments to be cleared. Missing field or empty array means none reviewed. Orphan SHAs after rebase/amend are left in place (same as comments and message edits).

```json
{
  "reviewedShas": [
    "abc1234def5678..."
  ]
}
```
