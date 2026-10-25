# @pi-ext/task-manager

Simple Pi task manager extension with always-on widget UI.

Tools:
- `task_create` (supports `parent_id` for session ancestry)
- `task_list`
- `task_update`
  - supports `lane`, `depends_on`, `blocker`, `clear_blocker`, `blocked_by`, `clear_blocked_by`, `input_tokens_delta`, `output_tokens_delta`, `cost_usd_delta`
  - when status moves to `done`, a session summary is attached and emitted as `task-manager:merge-summary`
- `task_peek` (inspect task without changing state)

Widget:
- shown by default
- selectable list (`j`/`k` via `/tasks down` and `/tasks up`)
- shows blockers, lane/dependency shape, duration, input/output tokens, and cost
- header includes `ready` count for parallel-runnable tasks

Command:
- `/tasks` (interactive menu: view/create/clear/settings)
- `/tasks toggle` (show/hide widget)
- `/tasks clear` (clear all tasks, no confirmation)
- `/tasks focus` (focus widget)
- `/tasks overlay` (open interactive overlay)
- `/tasks up` / `/tasks down` (move selection)
- `/tasks select <task-id>`
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
- `/tasks ui bottom|show|hide`
- `/tasks restart` / `r` (re-run a task after crash/interruption)
- `/tasks pause` / `P` (pause a running worker; resumable)
- `/tasks steer` / `m` (steer a running worker)
- `/tasks broadcast` / `b` (steer all running workers)
- `/tasks export` (write tasks.md)
- `/tasks help` (hotkeys and commands)

Behavior:
- Tasks run in the background by default; dispatch returns immediately.
- Children auto-start when their parent and all dependencies finish, inheriting the parent session context and model.
- `/tasks help` documents hotkeys; the widget body stays clean.

State persists as branch custom entries (`task-manager:snapshot`); each session has its own tasks. A mirror is written to `.pi/task-manager-state.json` (gitignored) for other extensions.
Live state is emitted as `task-manager:state` for other extensions to subscribe to.
Tool failures (e.g. bash timeouts) are recorded as task notes.
Done-task summary merges are emitted as `task-manager:merge-summary` entries for main-tree ingestion.
