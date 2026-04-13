# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
