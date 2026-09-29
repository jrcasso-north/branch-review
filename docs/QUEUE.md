# Review queue

Line up a batch of pull requests and work through them without setting up each
one by hand. Paste the links, then keep pressing Next.

The queue lives at `~/.branch-review/queue.json`, outside any single repository,
because it spans them. `BRANCH_REVIEW_HOME` moves it.

## Adding pull requests

Paste into the Queue panel in the sidebar, one per line:

```text
https://github.com/owner/repo/pull/36
https://github.com/owner/other-repo/pull/122
```

`owner/repo#36` shorthand works too, and links with `/files`, `?w=1` or a
comment fragment are accepted. A line that is not a pull request link is
reported back rather than silently dropped.

Each entry is matched to a local clone, and the pull request head is fetched
into a local branch named `review/pr-<number>`, so nothing you were working on
is disturbed.

## Which clone a pull request maps to

Clones are matched on their `origin` remote, not on the folder name, so a
renamed checkout still matches and two folders with the same basename do not
collide. The repository has to be cloned already under a scanned folder; if it
is not, the entry stays in the queue carrying the reason, so a missing clone
never stops the rest of the batch being queued.

The base branch comes from GitHub when the `gh` CLI is available and logged in,
which also gives the title and author. Without it the queue falls back to the
same base inference the branch picker uses, and shows the entry without a title.

## Working through the queue

| Action | Effect |
| --- | --- |
| Click an entry | Opens that pull request: switches repo, sets both branches, loads the diff |
| Start / Next | Marks the open one done and opens the next that is ready |
| Clear done | Drops finished entries and keeps the rest |

Entries that could not be resolved are stepped over by Next rather than opening
into an error.

## Live updates

The panel follows the file. The server watches `queue.json` and streams changes
to the open page over `GET /api/queue/events`, so anything an agent appends
shows up without a reload, usually within a couple of hundred milliseconds.

The watch is on the directory rather than the file, because writes land through
a rename and that replaces the inode a file watch holds. Any writer therefore
triggers it: this server, an MCP server in another process, or an editor.

## From an agent

The MCP server carries the same queue, so Claude Code and Codex can fill it
while you keep reviewing, and the panel updates as they do. Entries they add are marked with a sparkle in the
sidebar so you can tell them apart from your own paste.

| Tool | Purpose |
| --- | --- |
| `enqueue_prs` | Add pull requests from pasted text |
| `list_pr_queue` | What is queued, open and done |
| `open_pr` | Open one entry by `owner/repo#number` |
| `next_pr` | Finish the open one and open the next |
| `remove_from_pr_queue` | Drop an entry, or clear everything finished |

Agents search for clones in the parent of the current repository. Set
`BRANCH_REVIEW_ROOTS` (path-separated) to point somewhere else.

Codex is wired the same way as any other MCP server, in `~/.codex/config.toml`:

```toml
[mcp_servers.branch-review]
command = "node"
args = ["/absolute/path/to/branch-review/bin/branch-review-mcp.js"]
```

See [docs/MCP.md](MCP.md) for the Claude Code and Cursor equivalents.
