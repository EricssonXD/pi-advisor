# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- TypeScript typechecking: `tsconfig.json`, dev dependencies on the pi packages, and a `typecheck` script wired into `npm run check`.
- Unit tests for stage detection, tool-result summarization, exit-code parsing, and verification-command matching (`tests/advisor-signals.test.mjs`).
- Edit/write summaries in advisor context now include `(+added/-removed)` line stats derived from the edit tool's unified patch details.

### Changed
- Removed the duplicated `<advisor-tool>` system prompt injection: usage guidance now lives solely in the tool's `promptGuidelines`, which pi injects natively when the tool is active. The executor system prompt no longer carries the advisor instructions twice.
- Advisor context (stage, directive, executor signals, recent tool activity) moved from the head of the transcript to the closing user message, next to where model attention is strongest; the advisor system prompt is now stage-agnostic and stable across calls.
- Advisor model calls now pass the pi session ID for provider-side cache affinity across repeated consultations.
- Extracted pure signal logic (`detectStage`, `summarizeToolResult`, `buildExecutorSignals`, `isVerificationCommand`, `shouldNudge`) into `src/advisor-signals.ts` so it is unit-testable without pi imports.
- Tool activity tracking now listens to the `tool_result` event, which carries tool input and typed details directly — the `tool_execution_start`/`tool_execution_end` bookkeeping and the per-call args map are gone.
- `isVerificationCommand` now matches the leading token of each pipeline segment instead of substrings anywhere in the command, so paths like `cat tests/foo.test.ts` no longer count as verification runs.
- Default advisor model is now `anthropic/claude-fable-5` (was `claude-opus-4-6`). Existing `advisor.json` files keep their configured model.
- Default `maxTokens` raised from `8192` to `16384` — adaptive-thinking models (Opus 4.6+, Fable 5) count thinking tokens against the output cap, and 8k risked truncated advice at `reasoning=high`.
- `/advisor on provider/model` now splits on the first slash only, so model IDs containing slashes (e.g. OpenRouter) work.

### Fixed
- Bash exit codes are now actually extracted from tool output: the parser looked for `exit code: N` while Pi's bash tool reports `Command exited with code N`, so the `(exit N)` suffix in advisor context never appeared.
- `/advisor on provider/model` no longer corrupts the in-memory config when the model is not found — validation now happens before the provider/model are assigned, so a later `/advisor config key=value` can no longer persist an invalid model.
- Failed advisor calls (model not found, missing API key, empty context) no longer consume the per-run usage quota; only calls that actually reach the model count.

## [0.2.1] - 2026-05-09

### Added
- Optional `stage` parameter for the `advisor` tool (`"initial"`, `"recovery"`, `"final-check"`) so executors can explicitly signal the current phase while preserving auto-detection as a fallback.

### Changed
- Migrated package imports and `peerDependencies` from `@mariozechner/*` to `@earendil-works/*` for the Pi namespace migration (v0.74+).
- Migrated `@sinclair/typebox` to `typebox` (TypeBox v1.x) for the Pi dependency migration.
- Rewrote `promptGuidelines` with actual function-call syntax to remove executor guesswork around advisor parameters.

## [0.2.0] - 2026-04-13

### Added
- Reasoning effort control for advisor model calls (`minimal`–`xhigh`, default `high`).
- `maxContextMessages` config to tune transcript size sent to the advisor (default `18`).
- Tab completion for `/advisor` subcommands (`on`, `off`, `config`, `ask`) and config keys (`provider=`, `model=`, `reasoning=`, etc.).

### Fixed
- Advisor tool crash on OpenAI-compatible providers caused by dangling `toolCall` blocks in the transcript — historical tool calls are now stripped from assistant messages, matching the already-skipped `toolResult` blocks.
- TUI rendering crash caused by `Box+Markdown` depth bug — replaced with `Container+Text` and corrected `renderResult` signature.
- Silent empty responses when advisor model returns only `thinking` blocks — thinking content is now used as a fallback.
- Missing error propagation when `completeSimple` returns `response.errorMessage`.

### Changed
- Moved `advisor-messages.ts` into `src/` directory for cleaner package layout.
- Rewrote README with architecture diagram, configuration reference table, and stage detection docs.
- Added LICENSE copyright holder and updated package manifest `files` field.
- Advisor prompts restructured to a consistent verdict + action items format (`On track` / `Course-correct` / `Not done yet`), with stage-specific directives for exploration, recovery, and final-check phases.
- Switched from `complete()` to `completeSimple()` to support `reasoning` parameter.

## [0.1.0] - 2026-04-10

### Added
- Initial `pi-advisor` package with a Pi extension that adds a Claude-style advisor tool for strategic guidance during complex coding tasks.
- `/advisor on`, `/advisor off`, `/advisor config`, and `/advisor ask` commands.
- Curated advisor context: bounded system prompt, active tools summary, and recent tool activity.
- Stage-aware guidance that adapts the advisor prompt based on executor activity.
- Compact advisor result rendering in the Pi TUI with token usage and expand-to-read hint.
- Per-run advisor usage limit (default 3 calls).
- Package metadata, smoke tests, MIT license, and install/use documentation for npm and GitHub distribution.
