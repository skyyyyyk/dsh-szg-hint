# dsh-szg-hint

English | [中文](README.md)

A sidecar hint plugin: drop a line into a running task, and the agent picks it up at its **next step** — without interrupting the task and without polluting the chat history.

The user drops a line while a task is running; the agent picks it up at its **next step**. The task is not interrupted and the main chat history stays clean.
A hint appears in exactly one step's request and is then marked as consumed (the UI receives a receipt).

Difference from the built-in `Agent.steer()` / `Agent.inject()`: messages sent through those channels enter the session history (see `agent/inbox/claimed`). This plugin injects through `agent/pre-step`, appending only to **the current step's** request and never calling `session.append` — so the hint is absent from the chat area after a page refresh, and the model sees it exactly once.

Install (pick one):

```sh
# from npm (after release)
dsh plugin --profile web add dsh-szg-hint

# from GitHub source (pnpm ≥10 asks you to allow build scripts; the first add fails with the exact package key)
dsh plugin --profile web add github:<owner>/dsh-szg-hint

# from a local checkout
dsh plugin --profile web add /path/to/dsh-szg-hint
```

Restart `dsh web` afterwards. To check only whether the layer is recognized, run `dsh --profile web --dump-config | grep dsh-szg-hint`.

## Halves and responsibilities

| Half | Responsibility |
|---|---|
| Host (`src/index.ts` + `src/store.ts` + `src/protocol.ts`) | Queue (JSONL on disk), data-plane routes `/dsh-szg-hint/*`, `agent/pre-step` injection, run-state subscription (`turn/start` / `turn/end`), `hint_send` / `hint_status` tools |
| Client (`src/client/`) | `./link.ts`, a single host link (SSE + fallback polling + writes), and `HintBar.tsx`, a compact entry docked at the right of the tool row (`conversation.input.right`: a 28px round button with a pop-up panel) — pending counter badge, input panel (Enter sends, Shift+Enter inserts a newline), pending list with cancel, recently consumed hints, and a toast in the top-right corner |

Both halves share the type contract in `src/protocol.ts` (types only, no runtime code).

Data lands in `$DSH_HOME/dsh-szg-hint/hints.jsonl` — an append-only event stream with two states, `put` and `del`; replaying it at startup yields the current state, and beyond 2000 lines it is compacted to "pending + the 20 most recently consumed". Persisting `consumed` is what makes a **restart not re-consume**: hints the model has already seen are never pushed a second time.

## Data channels

| Channel | Purpose | Behavior |
|---|---|---|
| `GET /dsh-szg-hint/events` (SSE) | Main channel | Every state change pushes one `event: state` frame (a full snapshot carrying `revision`); actions push one `event: hint` frame (`added` / `consumed` / `cancelled`, driving the toast); opening the stream writes a comment line and `retry` first, then a `: ping` every 25 seconds. Zero traffic when idle |
| `GET /dsh-szg-hint/state` | Polling fallback | Returns **the same** snapshot, used when SSE is unavailable (older host, proxy interference); every 4 seconds, backing off to 12 seconds after consecutive failures |
| `POST /dsh-szg-hint` | Enqueue | Passes the trust fence first (see below); body `{ text, sessionId? }` (`sessionId` omitted means global); returns `{ ok, hintId, running, dropped }`, where `running` reports whether that session is running a turn right now — the UI picks its wording from it |
| `DELETE /dsh-szg-hint` (body `{ id }`) | Cancel | Pending hints can be cancelled; an already-consumed hint returns 409 and an unknown one 404 (Chinese reason text, shown as-is by the UI). `DELETE /dsh-szg-hint/<id>` is the same action in path form, convenient for curl |

The browser half has a single application path (`normalizeSnapshot` plus state replacement) — pushed and polled snapshots are indistinguishable to the component.
Action frames only drive the toast (deduplicated by "action + hint id", so an SSE replay does not re-toast). The whole link disconnects while the page is hidden, so it never occupies the browser's per-origin connection budget.

## Trust fence (origin validation on the data plane)

Every data-plane path (`state` / `events` / `POST` / `DELETE`) passes the host's connection trust fence before dispatch: it reads `connection`'s `requestRejection(req)` and refuses with the original status code — `403` (untrusted host) or `401` (unauthenticated browser) — so only an authenticated page (one carrying the signed session cookie) is let through.

**Why same-origin checking is not enough**: `sameOrigin` inspects only browser cross-site requests that carry a foreign `Origin` header. A local process that sends no `Origin` (a script, another application) is let straight through — so any program on the machine could read the user's hint text and its session, or POST a hint; and a hint enters a running task as a plugin message, which amounts to arbitrary instruction injection. Origin validation has to live on the server.

- `connection` is a **hard dependency** (declared in `inject`) but is read structurally (`Reflect.get`) to avoid a cross-package type dependency; when the service is unavailable, every request answers `503` with a note on stderr rather than being silently allowed.
- The browser half needs no change: same-origin requests carry the cookie, so SSE, polling and writes all pass.
- Deployed standalone on a host without the `connection` service, authentication must be supplied at the gateway; otherwise the data plane is unusable (503).

## Injection semantics

- Extension point: the `agent/pre-step` waterfall — the same hook the memory plugin's per-turn section uses (after system-prompt assembly, before the model request) — but it **checks on every step**: the user may drop a hint at any moment while a task runs, and the next step should see it whether that is step 2 or step 20.
- Injection form: a user message with `plugin` source (`source.plugin = 'dsh-szg-hint'`, `form: snapshot`, section name "旁路提示"), appended to this step's message sequence; **it is not written to the chat history** and appears in this step only.
- Ownership: taken from the session in the pre-step payload (`payload.agent.session`); hints for that session and global ones (`sessionId = ''`) are consumed oldest-first, at most 20 per step. When the session id is unavailable, **only global hints are taken** — "I cannot tell whose hint this is" does not mean "I may feed another session's hints here".
- Atomicity: taking a hint marks it `consumed` in one synchronous stretch (no `await` in between, the equivalent of a transaction's SELECT+UPDATE on the source side); if building the injected message fails, the hint is **rolled back to pending** and retried on the next step — "marked consumed but the model never saw it" cannot happen.
- Receipt: a successful injection pushes a `hint` frame (`kind: consumed`) and the UI toasts "AI 已参考你的提示".

## Model Experience

- **What the model sees**: one user-role message whose body looks like

  ```text
  📌 旁路提示（用户在任务执行过程中插入，不占对话历史，仅本条可见）
  请在本步参考下面的要求，然后继续原来的任务；不要停下来等待确认，也不要把它当作新的用户回合。
  1. <hint text>
  ```

  A body longer than 600 characters is truncated for display (the queue keeps the full text, up to 2000).
- **Token cost**: one extra message in the steps that have a hint (an empty queue injects nothing at all, so there is no per-step cache churn). Hints arriving together are merged into a single message, at most 20.
- **KV cache**: with an empty pending queue the plugin has **zero effect** on the request; with hints, that step's message sequence gains one tail entry, and later steps return to the original sequence (a hint never appears twice).
- **Actions available to the model**: `hint_send` (deliver a hint to a session, defaulting to its own) and `hint_status` (inspect pending and recently consumed hints).

## Tools (model side)

| Tool | Purpose |
|---|---|
| `hint_send` | Deliver a hint to a session (`sessionId` omitted means the current one): `{ text, sessionId? }`. Returns the id, whether it takes effect immediately (whether the target session is running), and whether the oldest hint was evicted to respect that session's backlog cap |
| `hint_status` | Inspect the queue: `{ sessionId? }` (omitted means the current session, `*` means all sessions). Returns pending entries, whether that session is running, and recently consumed hints |

## Configuration

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | When off, routes, tools and event subscriptions are not registered |
| `dshHome` | `''` | Empty takes `DSH_HOME`, falling back to `~/.dsh` |
| `maxPerStep` | `20` | Maximum hints consumed per step (matches the source side; keeps a backlog from blowing up the context) |
| `maxContentChars` | `2000` | Maximum body length (code points; anything longer is truncated) |
| `maxPendingPerSession` | `20` | Pending cap per session; exceeding it evicts the oldest hint and reports it in the write response |
| `keepConsumed` | `20` | Recently consumed hints kept in the snapshot (also the number kept when compacting) |
| `heartbeatMs` | `25000` | SSE comment heartbeat interval |

## Mounting and rebuilding

The package ships its own `cordis.patch.yml` (one `insert` row with `id: dsh-szg-hint`), which `dsh plugin add` registers as a bundle layer of the profile. **New entries are not picked up by patchReload; restart `dsh web`.**

```sh
npm run typecheck   # tsc --noEmit (host and client together)
npm run build       # tsdown → lib/index.js (host) + lib/client.js (browser)
```

- Changing `src/client/` rebuilds `lib/client.js`, which hot-updates by content hash — no page refresh needed.
- Changing `src/index.ts` / `src/store.ts` (the host half) **requires restarting the dsh host**.

## Tests

| Case | Coverage | Command |
|---|---|---|
| `tests/store.spec.ts` | Queue contract (12 cases): atomic consumption without duplicates, oldest-first with a per-step cap, session and global scope, global-only when the session is unknown, the three cancel outcomes, rollback when injection fails, the per-session cap with `dropped` reporting, blank rejection and truncation, the run-state signal, no re-consume after restart, bad-line skipping, snapshot semantics | `npm test` |
| `tests/host-runtime-probe.mjs` | Host wiring (10 items): importable as ESM, export contract (name / inject / Config / apply), route prefix, both tools, both subscription kinds, everything registered through `ctx.effect` | `node tests/host-runtime-probe.mjs` |
| `tests/behavior.spec.ts` | Behavior (19 cases, needs a build first): the real HTTP data plane (enqueue / snapshot / three cancel outcomes / blank and cross-site rejection), injection semantics (session+global merge and numbering, no re-consume, session isolation, global-only when the session is unknown), **rollback to the next step when a downstream hook rejects this step**, concurrent takes without duplicates, backlog cap and over-length truncation, no re-injection after restart, bad-line tolerance, the model-side tool contract, and the **four trust-fence cases** (allowed / 401 read denial / 401 write denial without persisting / 403) | `npm test` |
| `tests/artifact-check.mjs` | Build-artifact check: how both halves honor the host contract (exports / route prefix / externalized dependencies / inlined CSS / same-origin paths), existence of every entry declared in `package.json`, and **bilingual README pairing** (both sides cross-link, and their blob hashes match the record in `README.i18n.yaml`) | `npm run test:artifact` |

## Known Limitations and Deferred Work

- **UI copy is hardcoded Chinese**: the interface language does not follow the host locale; supporting more languages means extracting all of it into locales.
- Text hints only: image or voice-note hints would need an attachment pipeline; the attachment channel in dsh's own composer can be used directly.
- Hints **do not enter the chat history**, so they are invisible in the chat area after a refresh; pending and recently-consumed hints come from the snapshot (not kept in client history, hence no cross-browser persistence either).
- Run state comes from `turn/start` / `turn/end`: after a host restart the in-memory "running" set is empty, so `running` is false until the first turn event (the wording degrades to "picked up by the next task", and the hint is still queued as usual).
- With several sessions in parallel the SSE stream pushes a global snapshot and each client filters to its own session; action frames from other sessions (a hint sent from another tab) do not toast in this tab.

## License

MIT (see `LICENSE`). The plugin extends the host through dsh's plugin protocol and changes no upstream source; host upgrades are bounded by the public contracts of `agent/pre-step` and `ctx.tools` / `webServer`.
