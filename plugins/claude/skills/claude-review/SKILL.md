---
name: claude-review
description: Run a Claude Code review against local git state through Claude's built-in reviewer. Use only when the user explicitly asks for a Claude review.
---

Run a Claude review through the shared built-in reviewer.

Runtime: the helper is `../../scripts/claude-companion.mjs` relative to this file; call it by absolute path from the repository root as `node <helper> ...`. It launches the local Claude Code CLI, which needs network access and writes under `~/.claude`, so request to run it outside the sandbox (escalated) from the start.

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Claude's output verbatim to the user.

Execution mode rules:
- If the user asked to wait, do not ask. Run the review in the foreground.
- If the user asked for background, do not ask. Run the review in the background.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then ask the user exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Do not add extra review instructions or rewrite the user's intent.
- `review` is native-review only. Claude's built-in reviewer (`/code-review`) picks its own target: the working tree when it has changes, otherwise the branch diff against the default branch. It does not support `--base`, `--scope`, or extra focus text.
- If the user needs a specific target, custom review instructions, or more adversarial framing, they should use the `claude-adversarial-review` skill.

Foreground flow:
- Run:
```bash
node <helper> review
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Run:
```bash
node <helper> review --background
```
- Do not wait for completion in this turn.
- After launching the command, tell the user: "Claude review started in the background. Check the claude-status skill for progress."
