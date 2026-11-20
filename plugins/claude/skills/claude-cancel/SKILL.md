---
name: claude-cancel
description: Cancel an active background Claude job in this repository. Use when the user asks to stop a Claude job.
---

Runtime: the helper is `../../scripts/claude-companion.mjs` relative to this file; call it by absolute path from the repository root. Request to run it outside the sandbox (escalated) if it fails inside it.

Run:

```bash
node <helper> cancel [job-id]
```

Present the command output to the user.
