# @pi-ext/task-manager

Pi task manager extension: background workers, dependency DAG, blockers, inspect/peek with streaming, interactive menu, usage metrics, and session-scoped persistence.

## Install

```sh
pi install ./extensions/task-manager
```

Or load locally:

```sh
pi --extension ./extensions/task-manager/index.ts
```

## Usage

- `/tasks` opens an interactive menu (view/create/clear/settings).
- Create tasks via the menu or the `task_create` tool; they auto-start when unblocked.
- `/tasks peek <id>` (or menu → View → Peek) streams live activity in a bordered popup.
- `/tasks help` shows commands and hotkeys.

Tools:
- `task_create` (supports `parent_id` for session ancestry)
- `task_list`
- `task_update`
  - supports `lane`, `depends_on`, `blocker`, `clear_blocker`, `blocked_by`, `clear_blocked_by`, `input_tokens_delta`, `output_tokens_delta`, `cost_usd_delta`
  - when status moves to `done`, a session summary is attached and emitted as `task-manager:merge-summary`
- `task_peek` (inspect task without changing state; streams activity)
- `task_steer` (send a message / answer a question to a running worker)

Widget:
- shown by default, above the editor
- compact list: status icon, task id, title, blocked/stuck flags, duration, tokens, cost
- header: `Tasks (N) — X running, Y pending, ...`
- in-progress rows show a spinner (⠋⠙⠹...); done rows are struck through and sorted to the bottom
- refreshes every 150ms

Command:
- `/tasks` (interactive menu: view/create/clear/settings)
- `/tasks toggle` (show/hide widget)
- `/tasks clear` (clear all tasks, no confirmation)
- `/tasks force-start` (starts selected task; clears blocker)
- `/tasks stop` (sets selected task to pending)
- `/tasks done [note]` (marks selected task done and injects session summary)
- `/tasks remove`
- `/tasks peek` or `/tasks inspect` (selected task)
- `/tasks block <reason>` / `/tasks unblock`
- `/tasks blockers` / `/tasks stuck`
- `/tasks tree` (shows dependency tree)
- `/tasks list` / `/tasks parallel`
- `/tasks run` (start all ready tasks)
- `/tasks restart` / `r` (re-run a task after crash/interruption)
- `/tasks pause` / `P` (pause a running worker; resumable)
- `/tasks steer` / `m` (steer a running worker)
- `/tasks broadcast` / `b` (steer all running workers)
- `/tasks export` (write tasks.md)
- `/tasks help` (hotkeys and commands)

Peek popup:
- bordered box, expanded by default (90% width/height)
- streams activity: thinking indicator, tool calls (compact, with code changes), steer messages, wrapped assistant responses
- vim-like modes: NORMAL (default) / INSERT (`i` to enter, `Esc` to exit)
- normal mode keys: `s` start, `f` force, `p` pause, `x` stop, `r` restart, `d` remove, `↑/↓` scroll, `PgUp/PgDn`, `End` tail, `Esc` close
- actions require `y` confirmation (any other key cancels)
- scrollable activity log; stays open after task completes

Behavior:
- Tasks run in the background by default; dispatch returns immediately.
- Children auto-start when their parent and all dependencies finish, inheriting the parent session context and model.
- Tasks can ask questions mid-flight via `task_question`; main agent answers autonomously via `task_steer`.
- `/tasks help` documents hotkeys.

State persists as branch custom entries (`task-manager:snapshot`); each session has its own tasks. A mirror is written to `.pi/task-manager-state.json` (gitignored) for other extensions.

Note: workers inherit auth/models from files under the agent dir; runtime-registered providers/virtual models from the main session are not propagated. Forked context is trimmed to the last 80 entries to avoid oversized payloads.
Live state is emitted as `task-manager:state` for other extensions to subscribe to.
Tool failures (e.g. bash timeouts) are recorded as task notes.
Done-task summary merges are emitted as `task-manager:merge-summary` entries for main-tree ingestion.