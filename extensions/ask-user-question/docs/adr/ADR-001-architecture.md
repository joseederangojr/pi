# ADR-001: Architecture for ask-user-question Extension

## Status

Proposed

## Context

We need a Pi extension in this monorepo providing a structured `ask_user_question` tool
mirroring `@juicesharp/rpiv-ask-user-question`. The extension must integrate with the
monorepo's TypeScript + native Node test setup (experimental strip types).

## Decision

### Module layout

```
extensions/ask-user-question/
  index.ts                 # default export: register tool + reconciler
  ask-user-question.ts     # tool registration + execute
  answer-channel.ts        # dialog walker for RPC hosts
  presentation.ts          # tabbed overlay presentation (lazy-loaded)
  reconcile.ts             # before_agent_start reconciler
  config.ts                # config file loader
  events.ts                # event types + emitters
  state/                   # questionnaire session state
  view/                    # TUI components
  locales/                 # i18n locale files
  docs/                    # ADR/PRD
```

### Key decisions

1. **Lazy-load the TUI session module** (like reference) to avoid pulling the ~560ms render graph on every load. Session load failures degrade to plain-chat fallback.

2. **Soft-optional i18n peer**: dynamic import of `@juicesharp/rpiv-i18n/loader`; no-op if absent. English fallback at every call site.

3. **RPC/ACP fallback**: detect `ctx.mode === "rpc"` and use native `select`/`input` dialogs; backstop for older builds where custom UI resolves without rendering.

4. **Non-interactive reconciliation**: `before_agent_start` hook strips `ask_user_question` when `!ctx.hasUI`; restored when UI returns. Idempotent.

5. **Validation**: TypeBox schema for structural limits; runtime `validateQuestionnaire` for semantic checks (reserved labels, duplicates).

6. **Config**: read-only config file at `~/.config/rpiv-ask-user-question/config.json` (XDG-aware); malformed JSON warns and falls back to defaults.

7. **Events**: emit prompt/blocked/answer/answer-result events for cross-extension observation.

8. **Testing**: native Node tests with strip types; mock UI helpers.

### Consequences

- Extension stays online in all environments (interactive, RPC, non-interactive).
- Adds dependency on pi-tui for overlay rendering.
- Localization optional; English fallback always works.
- Larger surface area than task-manager; more test coverage needed.