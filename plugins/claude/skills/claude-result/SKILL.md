---
name: claude-result
description: Show the stored final output for a finished Claude job in this repository. Use when the user asks for the result of a Claude job.
---

Runtime: the helper is `../../scripts/claude-companion.mjs` relative to this file; call it by absolute path from the repository root. Request to run it outside the sandbox (escalated) if it fails inside it.

Run:

```bash
node <helper> result [job-id]
```

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `claude --resume <session-id>`
