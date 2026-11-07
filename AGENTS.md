# polylogue-claude-code

The polylogue plugin for Claude Code: a mod, `hooks/register.js`, on Claude Code's mods API.
polylogue's design is in `../project`, and its AGENTS.md is `../AGENTS.md`.

## Testing a local copy

The managed policy, `allowManagedHooksOnly`, blocks every `--plugin-dir` copy, and says so only in the debug log.
So test on the server, in a session the policy doesn't reach, without luis's credentials:

- A fresh `CLAUDE_CONFIG_DIR` in `/tmp`.
- `CLAUDE_CODE_OAUTH_TOKEN` from `~/secrets/claude-main-token.txt`, a setup token.
- `bwrap` hiding `/etc/claude-code`, where the policy lives; the Mac has no `bwrap`.
- `claude -p --plugin-dir .`: mods and their tools run in `-p` mode too.

The plugin's tools are deferred, and a headless agent may not find them on its own:
name them in its prompt (`mcp__polylogue__join`, `mcp__polylogue__send`, `mcp__polylogue__leave`).

`tsc` checks nothing here, since `register.js` is plain JavaScript: `node --check` and a live run are the checks.

A version reaches luis's machines through dothome's pin, which setup-fixer moves.

Provenance: agent-autonomous
