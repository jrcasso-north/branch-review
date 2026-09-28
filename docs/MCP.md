# MCP server

`branch-review-mcp` exposes the review comments in `.branch-review/` to an MCP
client over stdio, so an agent can read what you wrote and apply it without you
copying anything across.

The server reads the same files the UI writes. It does not need the web app to
be running, and it never talks to the network.

## Connect it to Claude Code

Point the client at the bin in this checkout. The package is not published, so
use an absolute path:

```bash
claude mcp add branch-review -- node /absolute/path/to/branch-review/bin/branch-review-mcp.js
```

Or commit a `.mcp.json` in the repo you are reviewing, so everyone working on it
gets the same wiring:

```json
{
  "mcpServers": {
    "branch-review": {
      "command": "node",
      "args": ["/absolute/path/to/branch-review/bin/branch-review-mcp.js"]
    }
  }
}
```

## Connect it to Cursor

Cursor reads `.cursor/mcp.json` in the project, and resolves `${workspaceFolder}`
inside `env`, which pins the server to the repo you have open:

```json
{
  "mcpServers": {
    "branch-review": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/branch-review/bin/branch-review-mcp.js"],
      "env": { "BRANCH_REVIEW_REPO": "${workspaceFolder}" }
    }
  }
}
```

Cursor cannot hold a long-lived request, so `watch_comments` is the wrong tool
there. Use `poll_comments`, which answers straight away. See
[Clients that cannot long-poll](#clients-that-cannot-long-poll).

## Which repository the tools act on

In order of precedence:

1. The `repo` argument on an individual tool call.
2. `BRANCH_REVIEW_REPO`, which the bin sets to the directory it was started from.
3. The current working directory.

Any path inside a work tree resolves to the repository root, so running the
client from a subdirectory is fine. The branch under review is whatever
`.branch-review/config.json` names, which is what you picked in the UI.

If you keep several repos side by side under one directory, that directory is
not itself a repo, so the cwd default has nothing to resolve. Pass `repo` on the
call, or set `BRANCH_REVIEW_REPO`.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_review_status` | Branch under review, its base, the commits in range, and comment counts |
| `list_comments` | Comments by status: `dispatched` (default), `open`, `resolved`, or `all` |
| `get_comment` | One comment plus the diff around the lines it covers |
| `resolve_comment` | Mark a comment done once the change is made |
| `watch_comments` | Block until you send a comment from the UI, then return it |
| `poll_comments` | Return what you sent since a cursor, without waiting |

### `watch_comments`

MCP servers cannot start work on their own; the client has to call in. So
`watch_comments` long-polls instead: it returns as soon as a comment is sent to
the agent, or returns an empty list when `timeoutSeconds` (default 120, max 600)
elapses. Call it again to keep waiting.

Each hand-off is returned once per server process. Resolving a comment takes it
out of the queue for good, which is why `resolve_comment` matters even when the
change is already committed. Taking a comment back and sending it again counts
as a new hand-off, so a comment an agent could not finish can be re-queued.

## Clients that cannot long-poll

`poll_comments` returns immediately with whatever was sent after `cursor`, plus
a `nextCursor` to pass to the next call:

```text
poll_comments {}                        -> 2 comments, nextCursor: X
poll_comments { "cursor": "X" }         -> nothing new, nextCursor: X
poll_comments { "cursor": "X" }         -> 1 comment,  nextCursor: Y
```

Treat the cursor as opaque and keep the newest one. It is a position in the
queue rather than a session handle, so it survives a restart or a dropped
connection, where the in-memory bookkeeping behind a bare `watch_comments` call
does not. `watch_comments` accepts the same `cursor` and returns the same
`nextCursor`, so a client that manages one can use either.

A page is capped (20 by default, 100 at most). When more is waiting the reply
says how many, so call again with the new cursor before idling.

Prefer `watch_comments` where the client supports it: it reacts the instant you
click the sparkle, instead of on your next poll.

## The loop

1. Review commits in the UI and leave comments as usual.
2. Send comments to the agent with the sparkle: on a single comment, in the
   commit header for everything on that commit, or in the sidebar for the whole
   branch. Each sent comment gets `dispatched: true` and an accent border.
3. The agent's `watch_comments` call returns that comment.
4. The agent calls `get_comment` for the diff context, edits the code, then
   calls `resolve_comment`.
5. The comment collapses in the UI as resolved. `dispatched` stays on the record
   so you can see the agent handled it.

Taking a comment back before the agent picks it up clears both dispatch fields.

## Run it directly

```bash
npm run mcp              # stdio server against the current directory
npm test                 # unit tests plus an end-to-end pass over stdio
```

Diagnostics go to stderr; stdout carries JSON-RPC only.
