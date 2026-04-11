# pi-advisor

`pi-advisor` is a Pi package that adds an `advisor` extension modeled after Claude's advisor strategy: the main executor keeps doing the work, and calls a stronger model only when it needs strategic guidance.

## What it does

- registers an `advisor` tool callable by the executor
- injects advisor timing guidance into the executor system prompt
- curates transcript context before calling the advisor model
- renders advisor output as a compact block in the Pi TUI
- exposes `/advisor` commands for enable/disable/config/manual trigger
- configurable reasoning effort (`minimal`–`xhigh`) via pi-ai `completeSimple` API
- tab completion for `/advisor` subcommands and config keys

## Install

### From npm

```bash
pi install npm:pi-advisor
```

### From a git repo

```bash
pi install git:github.com/RimuruW/pi-advisor
```

### For local development

```bash
pi -e ./index.ts
```

This package follows the Pi package manifest format and is discoverable as a **pi package** through the `pi-package` keyword.

## Usage

Enable the advisor with the default model:

```bash
/advisor on
```

Enable a specific model:

```bash
/advisor on anthropic/claude-opus-4-6
```

Set reasoning effort (default: high):

```bash
/advisor config reasoning=xhigh
```

Available levels: `minimal`, `low`, `medium`, `high`, `xhigh`.

Set max context messages sent to advisor (default: 18):

```bash
/advisor config maxContextMessages=24
```

Show config:

```bash
/advisor config
```

Update config:

```bash
/advisor config maxTokens=8192
```

Manually ask the executor to consult the advisor:

```bash
/advisor ask
```

Disable it:

```bash
/advisor off
```

## Package structure

```text
.
├── index.ts     # extension implementation and package entrypoint
├── package.json
├── README.md
└── tests/
```

## Development

Run the package smoke tests:

```bash
npm test
```

The tests verify:

- package manifest shape expected by Pi
- root `index.ts` entrypoint
- README install/usage instructions
- `pi -e ./index.ts` smoke loading
