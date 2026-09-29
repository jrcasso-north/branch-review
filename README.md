# branch-review

Local GitHub-style UI to review commits on a branch one at a time and leave comments on a commit, a file, a diff line, or a contiguous line range. Comments are stored as JSON under `.branch-review/` in the target repository.

This app does not apply fixes itself. A bundled MCP server hands the comments to an agent, which reads `.branch-review/` and changes the code. See [docs/MCP.md](docs/MCP.md).

<img width="1624" height="1061" alt="Screenshot 2026-09-18 at 12 40 47" src="https://github.com/user-attachments/assets/72bcc9a5-011e-4a52-83a9-6f155a88a0ec" />

## Quick start

```bash
cd branch-review
npm install
npm run build
npm start
```

Open http://localhost:8787 and pick a **Repo** in the sidebar.

By default the app scans the **current directory** for git repos (the directory
itself, and its immediate child folders). Pass a path to scan somewhere else:

```bash
npx branch-review /path/to/projects
# or a single repo
npx branch-review /path/to/your/repo
```

You can also choose **Change directory…** in the Repo list. That choice is
remembered for later visits unless you start with a path argument.

Dev (Vite UI on :5173, API on :8787):

```bash
npm run dev
```

## Flow

1. Choose **Repo**, **review branch**, and **base branch** in the UI. Branch choices are saved to that repo’s `.branch-review/config.json`. The app does not check out the review branch.
2. Review commits on the review branch that are not on the base branch.
3. Comment on a commit, a file, a diff line, or a contiguous range of lines (click and drag).
4. Comments are written to `.branch-review/comments/<branch-slug>.json` for the **review** branch.
5. Send comments to an agent with the sparkle, one at a time or a whole commit or branch at once. See [Handing comments to an agent](#handing-comments-to-an-agent).
6. Resolve a comment in the UI when it is done (keeps it on disk, collapsed). Hard-delete only for mistakes. Agents mark comments resolved after apply.

## Handing comments to an agent

`branch-review-mcp` is an MCP server over the same `.branch-review/` files. Wire
it into Claude Code once:

```bash
claude mcp add branch-review -- node /absolute/path/to/branch-review/bin/branch-review-mcp.js
```

Then send comments to the agent with the sparkle, at whichever scope suits you:

| Where | Sends |
| --- | --- |
| On a comment | That one comment |
| Commit header | Every unsent comment on that commit |
| Sidebar, under the branch | Every unsent comment on the review branch |

The bulk actions show a count and disappear once there is nothing left to send.
The agent waits on `watch_comments`, reads the diff context with `get_comment`,
applies the change, and calls `resolve_comment` so the thread collapses in the
UI.

Cursor works too, via `.cursor/mcp.json`. It cannot hold a long-lived request,
so it uses `poll_comments` (returns at once, with a cursor) rather than
`watch_comments`, and `.cursor/rules/branch-review.mdc` tells its agent to keep
checking rather than stopping on the first empty reply.

Full tool reference and setup notes: [docs/MCP.md](docs/MCP.md).

## On-disk layout

```text
.branch-review/
  .gitignore                 # ignores review data; no root .gitignore change
  config.json
  comments/<branch-slug>.json
```

Writes land through a temp file and a rename, guarded by a short-lived
`<branch-slug>.json.lock`, because the web app and the MCP server both write
here. Both are transient and covered by the directory's `.gitignore`.

Branch slug: `/` in the branch name becomes `--` (e.g. `feat/foo` → `feat--foo`).

See [docs/SCHEMA.md](docs/SCHEMA.md).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | API on `:8787` + Vite UI on `:5173` |
| `npm run build` | Build the UI into `dist/` |
| `npm start` | Serve API + built UI |
| `npm run mcp` | MCP server on stdio for the current directory |
| `npm test` | Unit tests plus an end-to-end pass over stdio |

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | API/UI port (default `8787`) |
| `BRANCH_REVIEW_CWD` | Caller cwd used when no path argument is given (set by the `branch-review` bin) |
| `BRANCH_REVIEW_REPO` | Repo the MCP server acts on (set by the `branch-review-mcp` bin) |

## Requirements

- Node 22+
- `git` on `PATH`
