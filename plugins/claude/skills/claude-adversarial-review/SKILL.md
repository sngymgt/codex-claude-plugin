---
name: claude-adversarial-review
description: Run a Claude Code review that challenges the implementation approach and design choices. Use only when the user explicitly asks for an adversarial or challenge review by Claude.
---

Run an adversarial Claude review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Runtime: the helper is `../../scripts/claude-companion.mjs` relative to this file; call it by absolute path from the repository root as `node <helper> ...`. It launches the local Claude Code CLI, which needs network access and writes under `~/.claude`, so request to run it outside the sandbox (escalated) from the start.

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Claude's output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If the user asked to wait, do not ask. Run in the foreground.
- If the user asked for background, do not ask. Run in the background.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then ask the user exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- It supports working-tree review, branch review, and `--base <ref>` (`--scope auto|working-tree|branch`).
- It does not support `--scope staged` or `--scope unstaged`.
- Unlike `claude-review`, it can still take extra focus text after the flags.

Foreground flow:
- Run:
```bash
node <helper> adversarial-review [--base <ref>] [--scope <scope>] [focus text]
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Run the same command with `--background`.
- Do not wait for completion in this turn.
- After launching the command, tell the user: "Claude adversarial review started in the background. Check the claude-status skill for progress."
