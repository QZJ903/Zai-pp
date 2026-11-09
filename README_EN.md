# Zai++

> Turns the [z.ai](https://chat.z.ai) web app into an AI agent workspace that can run local tools, connect to MCP servers, remember context, and execute tasks on a schedule.

## What it is

Zai++ is a browser extension (Chrome / Edge, Manifest V3) for the [z.ai](https://chat.z.ai) web app. It does not alter z.ai's answers. It adds five core capabilities to the page: **local tool execution**, **MCP server integration**, **long-term memory across conversations**, **browser control**, and **scheduled automation**.

The extension only orchestrates and renders. Actual local command execution happens in a separate Native Messaging process — the Shell Native Host — which runs on the user's own machine and shares no process with the web page or the extension's background.

**Local-first**: memories, Skills, saved items, automation tasks, and MCP configuration all live in the browser's local extension storage. Nothing passes through a relay server. Local tool output is produced and consumed entirely on your own machine.

**Supported sites**: `chat.z.ai` (global) and `zchat.z.ai` (China region). The two sites have independent sessions; the extension caches each separately without crossing them.

## Contents

- [What it is](#what-it-is)
- [At a glance](#at-a-glance)
- [Core features](#core-features)
- [Installation](#installation)
- [Credits](#credits)

## At a glance

| You want | Zai++ provides |
|---|---|
| AI agent workspace / browser extension | Turns the z.ai web app into an in-browser workspace that can call local tools, reuse memory, and schedule automation. |
| Local command execution / local shell | Runs `shell_exec` and `python_exec` on your own machine through the Shell Native Host, with persistent sessions. |
| Local file access | `local_file_read` / `local_file_write` / `local_file_stat`, including chunked reads of large files and a system folder picker. |
| MCP tools | Manage MCP servers, per-tool switches, execution policy, and prompt exposure strategy in the side panel; results return to the same conversation. |
| Long-term memory | Accumulates automatically, filters by relevance before injection, editable, categorised, importable and exportable. |
| Skills / `/skill` workflows | Built-in, custom, or imported from GitHub and local folders; load one by typing `/skill-name`. |
| Browser control | Lets the model read and operate a tab you pick, via the accessibility tree. 18 tools, enabled explicitly. |
| Automation | Runs a fixed task in a dedicated conversation on a Cron or RRULE schedule, triggerable manually, with run status. |
| System prompt presets | Prepare a fixed role or behavioural boundary for new conversations, injected before the first message. |
| Prompt controls | Independent switches for memory injection, system prompt, preset injection frequency, and forced reply language. |
| Saved items / snippets | Keep recurring prompts, answer snippets, and reference links; searchable, insertable into a conversation, exportable. |
| Usage statistics | Token usage by day and by model, session count, active days, and model distribution. |
| Bilingual UI | The side panel, tool descriptions, and built-in Skill behaviour follow the selected language; your own content is untouched. |
| Custom background | Set a custom background image on the z.ai page — upload a file or paste a URL, adjust opacity, clear it anytime. |

## Core features

### Local tools

Twelve tools provided by the Shell Native Host:

| Tool | Purpose |
|---|---|
| `shell_exec` | Run a one-off shell command |
| `shell_session_begin` / `shell_session_exec` / `shell_session_end` | Persistent shell sessions: keep working directory, environment variables, and process state |
| `python_exec` | Run short Python snippets (real local interpreter, not a browser sandbox) |
| `python_status` | Query the local Python interpreter status |
| `local_file_read` / `local_file_write` / `local_file_stat` | Read and write local files |
| `local_folder_pick` | Open the system folder picker |
| `local_skill_preview` | Preview a local Skill folder (used internally by the extension) |

- **Results return to the conversation** — tool output is fed back into the same turn so generation continues, with no manual copy-paste.
- **Chunked reads for large files** — files beyond the single-read limit are continued deterministically by the extension along Unicode code points, never silently truncated midway.
- **Failures are visible** — every failure carries a structured error code, and the UI gives an actionable explanation instead of a bare "failed".
- **Output is capped** — single-run stdout is truncated so one call cannot blow up the context.

### MCP tool system

Connect any MCP server from the side panel and turn its tools into capabilities the model can call.

- **Four transports** — stdio (local command), HTTP, SSE, plus the built-in Shell Native Host channel.
- **Discovery and caching** — tool lists are cached per server and re-discovered only when configuration changes.
- **Execution policy** — set each server to auto-execute, require confirmation, or stay disabled.
- **Per-tool toggles** — check individual tools; the model-facing catalog narrows accordingly.
- **Prompt exposure strategy** — three modes: direct (show every tool schema), adaptive (show only relevant tools, weightable by pinning), on-demand (schemas stay out of the prompt; the model discovers before calling).
- **Adaptive budget** — all adaptive servers share one cap on directly shown schemas, settable by both tool count and byte size.
- **Pinning** — weight a tool so it is not squeezed out in adaptive mode.
- **Call history** — the most recent tools and results per server, viewable inline.
- **Error translation** — raw English server errors become actionable messages (401/403, unreachable, timeout, oversized response, and so on).

### Long-term memory

- **Automatic accumulation** — preferences, feedback, background, and reference material worth keeping get written as entries.
- **Relevance-based injection** — each turn selects by keyword match, pinned weight, and access frequency, putting only the relevant entries into context.
- **Whole-block budget** — the injected total has a token cap and each entry a character cap; beyond that the top-scoring entries are taken.
- **Editable** — add, edit, pin, delete, or filter by category.
- **Import and export** — back up to JSON or restore from one; every entry is validated for shape and length before import.

### Skills

- **Two built-in** — `shell` (local command and file operation conventions) and `memory` (memory read/write conventions).
- **Custom Skills** — write the name, description, and instructions directly in the side panel; the name is normalised into a callable slug.
- **Import from GitHub** — repository, directory, or single `SKILL.md` links, with a preview before import; never overwrites local custom Skills.
- **Import from a local folder** — read a local Skill directory through the local tools; no script is executed during import.
- **Auto-activation** — optionally match and activate Skills from conversation content; when off, only an explicit `/skill-name` activates one.
- **Slash completion** — typing `/` in the composer pops up Skill candidates; arrow keys to move, Enter to pick.

### Browser control

Let the model operate a tab you pick — built on the Chrome DevTools Protocol and the accessibility tree.

- **18 tools** — navigate, back/forward, refresh, list and switch tabs, close tab, snapshot, click, hover, fill, fill form, key, type, attach file, wait for conditions, handle dialogs, evaluate script.
- **Accessibility-tree targeting** — operate elements by their snapshot node id, far more stable than CSS selectors; snapshot text has a byte budget so it cannot fill the context in one go.
- **Explicit opt-in** — off by default; once enabled you choose the controlled tab and can detach at any time.
- **z.ai's own tabs cannot be targets** — that tab's debug session belongs to background keep-alive.
- **Every action has a timeout and a result cap** — each tool declares its own.

### Automation

Hand a fixed task to a dedicated conversation, triggered manually or on a schedule.

- **Triggers** — manual, a five-field Cron expression, or RRULE (`MINUTELY` / `HOURLY` / `DAILY` plus an interval).
- **15-minute minimum interval** — anything tighter is rejected outright rather than silently skipped.
- **Fixed session** — reuse one conversation for every run, or start a new one each time.
- **Model selection applies to one run only** — the model chosen in the form affects this run and does not change the session's existing model.
- **Run history** — status, duration, and failure reason for every run; failures are mapped from error codes to actionable messages.
- **Pausing is not cancelling** — pausing only stops the schedule; a run already in progress finishes.

### Two tool sets, two channels

z.ai ships a set of server-side sandbox tools; Zai++ adds a set of local tools. The two have different scopes and can be chained together.

| Tools | Where they run | What they do |
|---|---|---|
| Server-side sandbox tools | z.ai's servers | Computation, format conversion, drafting, producing documents and charts |
| Local tools | Your own computer | Read and write local files, run local commands, reach your desktop and project directories |

- **Sandbox for intermediate work, local tools for the deliverable** — generate or process in the sandbox first, then use `local_file_write` to put text on your desktop; for binaries such as images, zips, and PDFs, convert to base64 in the sandbox first, then use `shell_exec` to decode and write them.
- **It works the other way too** — to analyse a local file, read it with `local_file_read` first, then hand the content to a sandbox tool.
- **Paths are not interchangeable** — local paths (`C:/`, `D:/`, your desktop) cannot be passed to sandbox tools, and sandbox paths (`/home/z/my-project/…`) cannot be passed to local tools.

### Continuation and self-correction

Once a tool has run, the reply should carry on. But z.ai's page **does not resume on its own** after tool results are filled back in — the extension feeds the result into the composer and makes the page send the next turn. That chain is called continuation.

- **Automatic continuation** — any turn that called an MCP, local, or browser tool gets the next turn queued automatically, up to 25 steps.
- **Pending-work detection (nudge)** — when the model says "next I will…" and then stops, the extension recognises an unclosed task and prompts another turn (up to 8 times). The judgement is by **subject**: "I'll do X" is a strong signal and always nudges; "next you can…" is a suggestion and does not.
- **Misuse correction** — when the model writes a local tool into a native `tool_call`, that turn executes nothing. The extension detects the misuse and sends a correction turn containing an example built from that tool's real parameter schema, asking it to resend via XML tags.
- **Session change ends the loop** — switching conversations immediately tears the continuation loop down, so results never land in the wrong conversation.
- **Failures reported honestly** — a turn that did not complete reports why, rather than quietly showing success.

### Background keep-alive

Background tabs get throttled by the browser: timers drop from millisecond resolution to once per second, and once a tab has been hidden for five minutes, to once per minute. The continuation chain contains several waits on the order of tens to hundreds of milliseconds (composer ready, send button enabled, send evidence) — push those to second resolution and they all time out, which shows up as a task that silently fails.

- **What it does** — sends two Chrome DevTools Protocol commands to the target tab: emulate page focus, and pin the page lifecycle to `active`. The tab then reports itself as foregrounded, and its timers stop being throttled.
- **When it does it** — by default only during the **few seconds of sending**, released immediately afterwards. A loop that runs past **3 minutes** switches to a sustained session until the loop ends.
- **Off by default** — because Chrome shows a "Zai++ started debugging this browser" banner at the top of the window while it is active. Worth enabling for long-running tasks; unnecessary otherwise.

### Prompts

- **System prompt presets** — prepare a fixed role or behavioural boundary for new conversations, injected before the first message when active; only one can be active at a time, and presets can be imported from or exported to a file.
- **Memory injection switch** — when off, new requests no longer carry long-term memory.
- **System prompt switch** — when off, tool schemas, memory rules, and runtime guidance are no longer injected.
- **Preset injection frequency** — four levels: default frequency, first message only, every message, off.
- **Forced reply language** — auto / Simplified Chinese / English; constrains model output only and never translates your own content.

### Saved items

- **Two kinds of entry** — snippets (reusable text) and bookmarks (reference links).
- **Search and tags** — search by keyword, group by comma-separated tags.
- **Insert into a conversation** — writes straight into the composer of the current z.ai conversation.
- **Export** — Markdown or JSON.

### Data management

- **Memory import and export** — whole-library backup and restore.
- **Diagnostic log export** — exports background tool execution and errors from the most recent session, for troubleshooting local tool authorisation and MCP connections.
- **Clear all memories** — completed in a single transaction; when corrupt data exists the whole operation is refused (fail-closed) rather than deleting half of it.

### Usage statistics

- **Totals and distribution** — total tokens, session count, message count.
- **Activity** — active days, current streak, activity heatmap.
- **Daily trend** — token usage per day.
- **Model distribution** — usage and share per model, with friendly model names.

### Interface

- **Bilingual** — follow the browser, Simplified Chinese, or English; the interface, tool descriptions, and built-in Skill behaviour switch together.
- **Page background** — set a custom background for the z.ai page, via upload or URL, with adjustable opacity.
- **Theme following** — injected UI follows the z.ai page's light/dark theme, not the system theme.
- **Tool call panel** — tools executed in one turn collapse into a single expandable block with two levels of folding, surviving a refresh; the result cards for saving a Skill or importing memories live inside it.
- **History cleanup** — after a refresh, tool call tags and continuation templates in history are stripped or hidden, so internal structure never leaks to the user.

## Installation

### Install the Shell Native Host

Side panel → **Capabilities** → **MCP** shows a copyable install command with the extension ID already filled in:

```bash
npx --yes zai-pp-shell-host install --browser <chrome|edge> --extension-id <your extension ID>
```

`--browser` takes `chrome`, `edge`, or `chromium`. The only requirement is Node.js ≥ 18.17.

**Restart the browser** after installing, then click "Test" on the MCP page to verify the connection.

The npm package is only a carrier: `install` copies the host runtime into your profile directory, so removing the global package afterwards does not affect the installed host.

Common commands:

```bash
npx --yes zai-pp-shell-host status --browser <chrome|edge>
npx --yes zai-pp-shell-host uninstall --browser <chrome|edge>
```

### Optional: connect an MCP server

Add a server on the MCP page with its transport and address. stdio servers require the corresponding command to be installed locally.

## Credits

Zai++ is a port of [DeepSeek++](https://github.com/zhu1090093659/deepseek-pp) (Apache-2.0) to [chat.z.ai](https://chat.z.ai). The architecture skeleton, the memory / Skill / MCP / automation layering, and the Native Shell Host all originate from that project.

Request signing and protocol details come from public reverse-engineering work:

- [zhipu-ai-proxy](https://github.com/petehsu/zhipu-ai-proxy) (CC BY-NC-SA 4.0, with a security-research clause) — the signing algorithm. That project documents publicly observable Web API behaviour and contains no proprietary Zhipu AI source code.
- [GLM-Free-API](https://github.com/izaart95-jpg/GLM-Free-API) (MIT) — SSE stream parsing.
- [zai-openai-proxy](https://github.com/xaoLiu1222/zai-openai-proxy) (MIT) — tool_calls parsing and session refresh.

`core/zai/sign.ts` is this project's own TypeScript implementation. The signing secret is a constant hard-coded in z.ai's own frontend, and the algorithm matches the public descriptions in the projects above.

## License

[Apache-2.0](LICENSE)