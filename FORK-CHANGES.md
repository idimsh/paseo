# Fork changes — idimsh/paseo

This fork of [getpaseo/paseo](https://github.com/getpaseo/paseo) carries a small patch queue for a private,
self-hosted engineering setup that runs Paseo daemons on WSL2 and drives agents from a director agent. Everything
else is upstream Paseo, unchanged.

## Base

| Field        | Value                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| Upstream     | `getpaseo/paseo`                                                                                         |
| Base commit  | `main` at `a4f696620b5d248598a882b1a78d82ec5038c74b` (2026-10-30, version 0.14.0)                        |
| Branches     | `main` mirrors upstream `main`; `director` = base commit + the patch queue below                         |
| Release tags | `<base short SHA>-director.<N>`, for example `a4f69662-director.1`                                       |
| Licence      | Apache-2.0, as upstream. Every modified file carries the notice `Modified in idimsh/paseo: PC-n` (§4(b)) |

## Patch queue

One commit per patch, each with its tests. Listed in application order.

| ID   | Patch                                                                                                                                                                                                                                               | Commit            | Status  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------- |
| PC-3 | `kill_agent`, `cancel_agent`, `archive_agent` take `serverId`; a stop on another host archives the agent; an agent neither live nor stored is an error. `cancel_agent_response` gains an optional `cancelled` field (`DaemonClient.cancelAgentRun`) | subject `PC-3: …` | patched |
| PC-2 | On Linux, identify a process by its start ticks (`/proc/<pid>/stat` field 22) plus the boot ID, so WSL2 clock drift no longer reaps live terminals                                                                                                  | —                 | planned |
| PC-1 | Note running agents synchronously at the start of daemon shutdown and keep their resume mark, so Claude Code and Pi agents resume too                                                                                                               | —                 | planned |
| PC-8 | "Allow, don't ask again" in the web UI; for an agent whose provider has a permission policy, the daemon moves the rule from `ask` to `allow`                                                                                                        | —                 | planned |

## Rebase onto a new upstream commit

1. `git fetch upstream`
2. `git switch main && git merge --ff-only upstream/main && git push origin main`
3. `git switch director && git rebase --onto <new base> <old base>`
4. Resolve conflicts one patch at a time; keep each patch a single commit.
5. Build (`npm run build:server`, `npm run build:daemon-web-ui`) and run each patch's tests from its package
   (`npx vitest run <file> --maxWorkers=4`).
6. Tag `<new base short SHA>-director.1` and push `director` and the tag to `origin`.

Never push to `upstream`.
