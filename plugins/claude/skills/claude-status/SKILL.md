---
name: claude-status
description: Show active and recent Claude jobs for this repository, including review-gate status. Use when the user asks how a Claude job is going, or after a Claude job was started in the background.
---

Runtime: the helper is `../../scripts/claude-companion.mjs` relative to this file; call it by absolute path from the repository root. Request to run it outside the sandbox (escalated) if it fails inside it.

Run:

```bash
node <helper> status [job-id] [--wait] [--all]
```

- Without a job ID it lists jobs from the current Codex thread (`--all` for every thread in this repository).
- With a job ID and `--wait`, it blocks until the job finishes (default up to 240 seconds, `--timeout-sec N`) and then prints the result.

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, and duration.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
