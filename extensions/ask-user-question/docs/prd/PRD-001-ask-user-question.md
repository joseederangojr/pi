# PRD: ask-user-question Extension

## Overview

A Pi extension that registers an `ask_user_question` tool — a structured questionnaire
the model can invoke when requirements are ambiguous, instead of guessing. Presents
typed options (single/multi-select) with previews, plus a "Type something." custom-answer
row, in a tabbed TUI overlay. Falls back to native dialogs on RPC/ACP hosts and removes
the tool entirely in non-interactive runs.

## Goals

- Give the model a structured way to ask clarifying questions (1-4 questions, 2-4 options each).
- Render a tabbed overlay with previews, multi-select, and a custom-answer row.
- Support RPC/ACP hosts via native select/input dialogs.
- Degrade gracefully (remove tool) when no UI is available.
- Localize UI strings via optional i18n peer.
- Emit events so other extensions can observe prompt/answer/blocked state.

## Non-goals

- Free-form chat (use normal conversation).
- Persisting answers across sessions (answers are in-tool results).
- Replacing the model's own reasoning.

## Feature set (from reference)

- Tool schema: `questions[]` with `question`, `header` (≤16 chars), `options[]` (label ≤60, description, preview?), `multiSelect`.
- Limits: 1-4 questions, 2-4 options, max 16-char header, max 60-char label.
- Reserved labels: "Other", "Type something.", "Next" rejected.
- Validation errors: no_questions, too_many_questions, duplicate_question, empty_options, reserved_label, duplicate_option_label, no_ui, no_custom_ui, session_load_failed, stale_module_cache.
- Result envelope: `{ answers: [{questionIndex, question, kind, answer, selectedLabels?}], cancelled, error? }`.
- TUI: tabbed overlay, preview pane, multi-select checkboxes, custom-answer row, notes.
- RPC fallback: native select/input dialogs, multi-select via comma input.
- Non-interactive: tool stripped from list via before_agent_start.
- Config: collapseKey, guidance (description, promptSnippet, promptGuidelines).
- i18n: optional peer, locales dir.
- Events: ASK_USER_PROMPT_EVENT, ASK_USER_ANSWER_EVENT, ASK_USER_BLOCKED_EVENT, ASK_USER_ANSWER_RESULT_EVENT.
- Reconciler: strips tool when no UI.

## Success criteria

- Typecheck clean, tests pass.
- Works in interactive TUI, RPC hosts, and non-interactive runs.
- Model never sees the tool when UI is unavailable.