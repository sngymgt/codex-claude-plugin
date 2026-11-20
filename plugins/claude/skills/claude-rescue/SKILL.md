---
name: claude-rescue
description: Proactively use when Codex is stuck, wants a second implementation or diagnosis pass, needs a deeper root-cause investigation, or should hand a substantial coding task to Claude Code through the shared runtime. Also use when the user asks to delegate, continue, or resume work with Claude.
---

Forward the rescue request to the Claude companion task runtime.
The final user-visible response must be Claude's output verbatim.

Runtime: the helper is `../../scripts/claude-companion.mjs` relative to this file; call it by absolute path from the repository root as `node <helper> ...`. It launches the local Claude Code CLI, which needs network access and writes under `~/.claude`, so request to run it outside the sandbox (escalated) from the start.

Selection guidance:

- Do not wait for the user to explicitly ask for Claude. Use this skill proactively when Codex should hand a substantial debugging or implementation task to Claude.
- Do not grab simple asks that Codex can finish quickly on its own.

Execution mode:

- If the request asks for background, add `--background` to the `task` call.
- If the request asks to wait, run in the foreground.
- If neither is requested, prefer foreground for a small, clearly bounded rescue request, and background for a task that looks complicated, open-ended, multi-step, or likely to keep Claude running for a long time.
- If the request says to resume, do not ask whether to continue. The user already chose.
- If the request says to start fresh, do not ask whether to continue. The user already chose.
- Otherwise, before starting Claude, check for a resumable rescue session from this Codex thread by running:

```bash
node <helper> task-resume-candidate --json
```

- If that helper reports `available: true`, ask the user exactly once whether to continue the current Claude session or start a new one.
- The two choices must be:
  - `Continue current Claude session`
  - `Start a new Claude session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Claude session (Recommended)` first.
- Otherwise put `Start a new Claude session (Recommended)` first.
- If the user chooses continue, add `--resume-last`.
- If the user chooses a new session, do not add `--resume-last`.
- If the helper reports `available: false`, do not ask. Route normally.

Forwarding rules:

- Use exactly one invocation of `node <helper> task ...` per rescue handoff. Pass the task text as the positional argument, or on stdin with `-` for long text.
- Default to a write-capable Claude run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.
- Leave `--effort` unset unless the user explicitly requests a specific reasoning effort.
- Leave model unset by default. Only add `--model` when the user explicitly asks for a specific model.
- Treat `--effort <value>`, `--model <value>`, background/wait, and resume/fresh as runtime controls and do not include them in the task text you pass through.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own as part of the handoff.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel` from this skill. It only forwards to `task`.
- If the user did not supply a request, ask what Claude should investigate or fix.

Response style:

- Return the stdout of the `task` command exactly as-is. Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- For a background run, tell the user the job ID and that progress is available through the claude-status skill.
- If the helper reports that Claude is missing or unauthenticated, stop and tell the user to run the claude-setup skill.
- If the command fails or Claude cannot be invoked, do not generate a substitute answer. Report the failure and stop.
