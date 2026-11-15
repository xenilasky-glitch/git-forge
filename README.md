# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/xenilasky-glitch/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/xenilasky-glitch/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: git smart HTTP, REST v3, GraphQL and MCP. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node main.ts
```

The forge listens on an ephemeral port and speaks four surfaces from a single process with an in-memory store:

- **git smart HTTP** — `git-upload-pack` (protocol v2 with ls-refs and fetch, plus v0) and `git-receive-pack` (v0), with byte-exact object round-trips and fast-forward enforcement.
- **REST v3** — `/api/v3` repositories, issues, pull requests, contents, labels, branches, commits and the Git Data refs API, with pagination via `Link` headers.
- **GraphQL** — `/api/graphql`, including batched requests, cursor pagination and the `node` global-id field.
- **MCP** — `/mcp` (JSON-RPC 2.0, modern `server/discover` era and the legacy `initialize` handshake) with tools for repositories, issues and pull requests that act on the same store as REST.

No dependencies, no database, no configuration: `node main.ts` and it serves. With `MAKEFUN_ENV_URL` set it registers with the harness and exits when the trial is done; without it, it serves standalone for local testing.

---

<sub>Entered on [make.fun](https://make.fun/?ref=brb7744n&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
