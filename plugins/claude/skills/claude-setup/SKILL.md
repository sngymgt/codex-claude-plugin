---
name: claude-setup
description: Check whether the local Claude Code CLI is ready and optionally toggle the stop-time review gate. Use when the user asks to set up the Claude plugin, check Claude, or enable/disable the Claude review gate.
---

Runtime: the helper is `../../scripts/claude-companion.mjs` relative to this file; call it by absolute path from the repository root. It launches the local Claude Code CLI, so request to run it outside the sandbox (escalated) from the start.

Run:

```bash
node <helper> setup [--enable-review-gate|--disable-review-gate]
```

If the result says Claude is unavailable:
- Do not install anything. Tell the user to install Claude Code or run `claude auth login`, then rerun setup.

Output rules:
- Present the final setup output to the user.
- If Claude is installed but not authenticated, preserve the guidance to run `claude auth login`.
- When the review gate is enabled, tell the user that the gate only runs once Codex trusts this plugin's hooks (`/hooks` in the CLI, Review hooks in the desktop app), and that trust must be granted again after each plugin update.
