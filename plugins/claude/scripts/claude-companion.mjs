#!/usr/bin/env node
// Codex から Claude Code（`claude -p`）を呼ぶランタイム。openai/codex-plugin-cc の codex-companion.mjs の
// 役割を Claude 向けに写したもの。依存なし。
//
//   setup               [--enable-review-gate | --disable-review-gate] [--json]
//   task                [--write] [--resume-last] [--model M] [--effort E] [--background] [--prompt-file F] [prompt | stdin]
//   task-resume-candidate --json
//   review              [--background]                      Claude の組み込みレビュー（/code-review）
//   adversarial-review  [--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]
//   status              [job-id] [--wait] [--timeout-sec N] [--all]
//   result              [job-id]
//   cancel              [job-id]
//   stop-gate | session-end   （Codex のフックから呼ばれる。stdin にフック入力）

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.dirname(path.dirname(SELF));
const STATE_ROOT = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "codex-claude",
);

// Claude Code が起動したシェルには CLAUDECODE=1 が入る。Claude → Codex → Claude と
// 入れ子になると互いに呼び合って止まらなくなるので、既定では断る。
const NESTED_ENV = "CODEX_CLAUDE_BRIDGE";

// これらが環境にあると `claude -p` はサブスクではなく従量課金（API キー・Bedrock・Vertex 等）で動く。
// Codex を起動したシェルに入っていても、黙って課金先が変わらないよう必ず外す。
const BILLING_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

// Codex の read-only サンドボックスに当たるもの。dontAsk は事前に許した道具以外を黙って断る。
// git の参照系にも書き込み・実行のオプション（diff --output、grep -O 等）があるので、
// この一覧だけでは守れない。書き込みを止めているのは SANDBOX_SETTINGS の方
const READ_ONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
  "Bash(git blame:*)",
  "Bash(git merge-base:*)",
  "Bash(git ls-files:*)",
  "Bash(git rev-parse:*)",
];
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];
const BUILTIN_TOOLS = ["Read", "Grep", "Glob", "Bash"];

const JOB_ID = /^cl-[a-z0-9]+-[0-9a-f]{6}$/;

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const RESUME_PROMPT = "Continue from where you left off.";

// ---------- 引数 ----------

const BOOL_FLAGS = new Set([
  "write",
  "resume-last",
  "resume",
  "fresh",
  "background",
  "wait",
  "json",
  "all",
  "allow-nested",
  "enable-review-gate",
  "disable-review-gate",
]);

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (BOOL_FLAGS.has(k)) opts[k] = true;
      else if (inline !== undefined) opts[k] = inline;
      else opts[k] = argv[++i];
    } else rest.push(a);
  }
  return { opts, rest };
}

function die(msg, code = 1) {
  process.stderr.write(`claude-companion: ${msg}\n`);
  process.exit(code);
}

// ---------- git ----------

const git = (cwd, ...args) =>
  spawnSync(gitBin(), args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: safeSpawnEnv(process.env), windowsHide: true });

function gitChecked(cwd, ...args) {
  const r = git(cwd, ...args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

function workspaceRoot(cwd) {
  const r = git(cwd, "rev-parse", "--show-toplevel");
  return r.status === 0 ? r.stdout.trim() : path.resolve(cwd);
}

const lines = (s) => s.trim().split("\n").filter(Boolean);
const uniqueFiles = (...groups) => [...new Set(groups.flat().filter(Boolean))].sort();

function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD");
  if (symbolic.status === 0 && symbolic.stdout.trim().startsWith("refs/remotes/origin/")) {
    return symbolic.stdout.trim().replace("refs/remotes/origin/", "");
  }
  for (const c of ["main", "master", "trunk"]) {
    if (git(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${c}`).status === 0) return c;
    if (git(cwd, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${c}`).status === 0) return `origin/${c}`;
  }
  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

function workingTreeState(cwd) {
  const staged = lines(gitChecked(cwd, "diff", "--cached", "--name-only"));
  const unstaged = lines(gitChecked(cwd, "diff", "--name-only"));
  const untracked = lines(gitChecked(cwd, "ls-files", "--others", "--exclude-standard"));
  return { staged, unstaged, untracked, isDirty: staged.length + unstaged.length + untracked.length > 0 };
}

function resolveReviewTarget(cwd, { scope = "auto", base = null } = {}) {
  if (base) return { mode: "branch", label: `branch diff against ${base}`, baseRef: base };
  if (scope === "working-tree") return { mode: "working-tree", label: "working tree diff" };
  if (!["auto", "branch"].includes(scope)) {
    throw new Error(`Unsupported review scope "${scope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`);
  }
  if (scope === "auto" && workingTreeState(cwd).isDirty) return { mode: "working-tree", label: "working tree diff" };
  const detected = detectDefaultBranch(cwd);
  return { mode: "branch", label: `branch diff against ${detected}`, baseRef: detected };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, rel) {
  const abs = path.join(cwd, rel);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return `### ${rel}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) return `### ${rel}\n(skipped: directory)`;
  if (stat.size > MAX_UNTRACKED_BYTES) return `### ${rel}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) return `### ${rel}\n(skipped: binary file)`;
  return [`### ${rel}`, "```", buf.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectReviewContext(cwd, target) {
  const repoRoot = gitChecked(cwd, "rev-parse", "--show-toplevel").trim();
  if (target.mode === "working-tree") {
    const state = workingTreeState(repoRoot);
    const staged = gitChecked(repoRoot, "diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff");
    const unstaged = gitChecked(repoRoot, "diff", "--binary", "--no-ext-diff", "--submodule=diff");
    const changed = uniqueFiles(state.staged, state.unstaged, state.untracked);
    const includeDiff =
      changed.length <= DEFAULT_INLINE_DIFF_MAX_FILES &&
      Buffer.byteLength(staged + unstaged, "utf8") <= DEFAULT_INLINE_DIFF_MAX_BYTES;
    const status = gitChecked(repoRoot, "status", "--short", "--untracked-files=all");
    const untrackedBody = state.untracked.map((f) => formatUntrackedFile(repoRoot, f)).join("\n\n");
    const parts = includeDiff
      ? [
          formatSection("Git Status", status),
          formatSection("Staged Diff", staged),
          formatSection("Unstaged Diff", unstaged),
          formatSection("Untracked Files", untrackedBody),
        ]
      : [
          formatSection("Git Status", status),
          formatSection("Staged Diff Stat", gitChecked(repoRoot, "diff", "--shortstat", "--cached")),
          formatSection("Unstaged Diff Stat", gitChecked(repoRoot, "diff", "--shortstat")),
          formatSection("Changed Files", changed.join("\n")),
          formatSection("Untracked Files", untrackedBody),
        ];
    return { repoRoot, includeDiff, content: parts.join("\n"), empty: changed.length === 0 };
  }
  const mergeBase = gitChecked(repoRoot, "merge-base", "HEAD", target.baseRef).trim();
  const range = `${mergeBase}..HEAD`;
  const changed = lines(gitChecked(repoRoot, "diff", "--name-only", range));
  const diff = gitChecked(repoRoot, "diff", "--binary", "--no-ext-diff", "--submodule=diff", range);
  const includeDiff =
    changed.length <= DEFAULT_INLINE_DIFF_MAX_FILES && Buffer.byteLength(diff, "utf8") <= DEFAULT_INLINE_DIFF_MAX_BYTES;
  const log = gitChecked(repoRoot, "log", "--oneline", "--decorate", range);
  const stat = gitChecked(repoRoot, "diff", "--stat", range);
  const parts = includeDiff
    ? [formatSection("Commit Log", log), formatSection("Diff Stat", stat), formatSection("Branch Diff", diff)]
    : [formatSection("Commit Log", log), formatSection("Diff Stat", stat), formatSection("Changed Files", changed.join("\n"))];
  return { repoRoot, includeDiff, content: parts.join("\n"), empty: changed.length === 0 };
}

// ---------- 状態 ----------

function stateDir(root) {
  const slug = path.basename(root).replace(/[^\w.-]/g, "_");
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const dir = path.join(STATE_ROOT, `${slug}-${hash}`);
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  return dir;
}

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
const writeJson = (p, v) => {
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 2));
  fs.renameSync(`${p}.tmp`, p);
};

const configPath = (root) => path.join(stateDir(root), "config.json");
const getConfig = (root) => ({ stopReviewGate: false, ...(readJson(configPath(root)) ?? {}) });

// Codex はシェルのコマンドに自分のスレッド ID を渡す。元のプラグインが Claude のセッションごとに
// ジョブを分けているのを、Codex のスレッドごとに置き換える
function currentThreadId() {
  return process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || null;
}

function listJobs(root) {
  const dir = path.join(stateDir(root), "jobs");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(dir, f)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function jobsForThread(root, threadId, all = false) {
  const jobs = listJobs(root);
  return all || !threadId ? jobs : jobs.filter((j) => j.threadId === threadId);
}

function jobPath(root, id) {
  // ID はそのままファイル名になる。`../` 等で状態の置き場の外を読み書きさせない
  if (!JOB_ID.test(id)) die(`Invalid job ID: ${id}`);
  return path.join(stateDir(root), "jobs", `${id}.json`);
}

function loadJob(root, id) {
  const job = readJson(jobPath(root, id));
  return job && job.id === id ? job : null;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Codex のサンドボックスからは外のプロセスにシグナルを送れず EPERM になる。生きている扱いにする
    return e.code === "EPERM";
  }
}

function effectiveStatus(job) {
  return ["queued", "running"].includes(job.status) && job.pid && !isAlive(job.pid) ? "lost" : job.status;
}

function isNested() {
  return Boolean(process.env.CLAUDECODE || process.env[NESTED_ENV]);
}

// ---------- Claude の呼び出し ----------

const IS_WINDOWS = process.platform === "win32";

// Bash を Claude Code のサンドボックスの中で動かす。許可した git の参照系にも書き込み・実行の
// オプションがあるので、読むだけの実行では書き込みそのものを OS の側で止める
// Codex の read-only / workspace-write サンドボックスと同じく、コマンドは何でも走らせてよいが、
// 書き込みと通信は OS の側で止める。許可リストでコマンドを絞ると /code-review の複合コマンドが丸ごと断られる
function sandboxSettings({ readOnly, cwd }) {
  const sandbox = { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false };
  // サンドボックスは既定で作業フォルダに書ける。読むだけの実行ではそこも塞ぐ
  if (readOnly) sandbox.filesystem = { denyWrite: [workspaceRoot(cwd)] };
  return { sandbox };
}

// Windows は名前だけで起動すると作業フォルダを先に探す。レビュー中のリポジトリに置かれた
// git.exe / claude.exe を動かさないよう、PATH の絶対パスの場所だけから探して絶対パスで起動する
function findOnPath(names) {
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter((d) => d && path.isAbsolute(d))) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// { command, prefixArgs }。spawn はシェルを通さない（プロンプトや差分をシェルに解釈させない）
function resolveClaude() {
  if (process.env.CLAUDE_BIN) return { command: process.env.CLAUDE_BIN, prefixArgs: [] };
  // シェルのラッパー（cmux 等）が `claude` を横取りすると -p が素通りしないことがあるので、
  // 公式インストーラの置き場所を先に見る。
  const native = path.join(os.homedir(), ".local", "bin", IS_WINDOWS ? "claude.exe" : "claude");
  if (fs.existsSync(native)) return { command: native, prefixArgs: [] };
  if (!IS_WINDOWS) return { command: "claude", prefixArgs: [] };
  const exe = findOnPath(["claude.exe"]);
  if (exe) return { command: exe, prefixArgs: [] };
  // npm の claude.cmd は Node がシェル無しでは起動しないので、包んでいる cli.js を node で直接起動する
  const cmd = findOnPath(["claude.cmd"]);
  const cli = cmd && path.join(path.dirname(cmd), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  if (cli && fs.existsSync(cli)) return { command: process.execPath, prefixArgs: [cli] };
  throw new Error("claude CLI not found. Install Claude Code (claude.exe) or set CLAUDE_BIN to its absolute path.");
}

let gitPath = null;
function gitBin() {
  if (!IS_WINDOWS) return "git";
  gitPath ??= findOnPath(["git.exe"]);
  if (!gitPath) throw new Error("git.exe not found on PATH.");
  return gitPath;
}

function safeSpawnEnv(env) {
  // 子のプロセスが名前だけでコマンドを探すときも、作業フォルダを候補にさせない
  return IS_WINDOWS ? { ...env, NoDefaultCurrentDirectoryInExePath: "1" } : env;
}

// Claude Code のサンドボックスは macOS（sandbox-exec）と Linux（bubblewrap＋socat）だけ。
// 使えない所で Bash を渡すと、読むだけの実行でも書き込みが止まらないので渡さない
function sandboxAvailable() {
  if (process.platform === "darwin") return true;
  if (process.platform === "linux") return !!(findOnPath(["bwrap"]) && findOnPath(["socat"]));
  return false;
}

function spawnClaudeSync(args) {
  const { command, prefixArgs } = resolveClaude();
  return spawnSync(command, [...prefixArgs, ...args], { encoding: "utf8", env: claudeEnv(), windowsHide: true });
}

function claudeEnv() {
  const env = { ...process.env, [NESTED_ENV]: "1" };
  for (const k of BILLING_ENV) delete env[k];
  // 起動元のアプリの値を引き継ぐと、その履歴の一覧に会話が混ざる
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return safeSpawnEnv(env);
}

function claudeAvailability() {
  try {
    resolveClaude();
  } catch (e) {
    return { available: false, detail: e.message };
  }
  const v = spawnClaudeSync(["--version"]);
  if (v.status !== 0) return { available: false, detail: "claude CLI not found or not runnable" };
  const auth = spawnClaudeSync(["auth", "status"]);
  try {
    const a = JSON.parse(auth.stdout);
    if (!a.loggedIn) return { available: false, version: v.stdout.trim(), detail: "not logged in (run `claude auth login`)" };
    return { available: true, version: v.stdout.trim(), authMethod: a.authMethod, subscription: a.subscriptionType ?? null };
  } catch {
    return { available: false, version: v.stdout.trim(), detail: "could not read `claude auth status`" };
  }
}

// プロンプトは標準入力で渡す（Windows のコマンドラインは 32K 文字までで、差分を埋め込むと溢れる）。
// --restricted でユーザー・リポジトリの settings を読まない。読むと、その allow（例: 外部サービスに書く CLI）が
// dontAsk でもそのまま通る。--strict-mcp-config で MCP サーバーも読まない
function buildClaudeArgs({ write, sessionId, model, effort, schemaFile, persist = true }, cwd) {
  const args = ["-p", "--output-format", "json", "--restricted", "--strict-mcp-config"];
  const tools = sandboxAvailable() ? BUILTIN_TOOLS : BUILTIN_TOOLS.filter((t) => t !== "Bash");
  if (!persist) args.push("--no-session-persistence");
  if (write) {
    args.push("--tools", ...tools, ...WRITE_TOOLS);
    args.push("--settings", JSON.stringify(sandboxSettings({ readOnly: false, cwd })));
    args.push("--permission-mode", "acceptEdits", "--allowedTools", ...READ_ONLY_TOOLS, ...WRITE_TOOLS);
  } else {
    args.push("--tools", ...tools);
    args.push("--settings", JSON.stringify(sandboxSettings({ readOnly: true, cwd })));
    args.push("--permission-mode", "dontAsk", "--allowedTools", ...READ_ONLY_TOOLS, "--disallowedTools", ...WRITE_TOOLS);
  }
  if (schemaFile) args.push("--json-schema", fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", schemaFile), "utf8"));
  if (sessionId) args.push("--resume", sessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return args;
}

function runClaude(spec, cwd, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    const { command, prefixArgs } = resolveClaude();
    const child = spawn(command, [...prefixArgs, ...buildClaudeArgs(spec, cwd)], {
      cwd,
      env: claudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.end(spec.prompt);
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs)
      : null;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        // 認証切れなどは JSON にならず stderr に出る
      }
      resolve({
        ok: code === 0 && !!parsed && !parsed.is_error,
        exitCode: code,
        timedOut,
        sessionId: parsed?.session_id ?? null,
        rawOutput: parsed?.result ?? "",
        structured: parsed?.structured_output ?? null,
        permissionDenials: parsed?.permission_denials ?? [],
        stderr: err.trim(),
        unparsedStdout: parsed ? "" : out.trim(),
      });
    });
  });
}

// ---------- プロンプト ----------

function renderTemplate(name, vars) {
  const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", `${name}.md`), "utf8");
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function readTaskPrompt(cwd, opts, rest) {
  if (opts["prompt-file"]) return fs.readFileSync(path.resolve(cwd, opts["prompt-file"]), "utf8");
  if (rest.length === 1 && rest[0] === "-") return fs.readFileSync(0, "utf8");
  const positional = rest.join(" ");
  if (positional) return positional;
  return process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
}

// ---------- 表示 ----------

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2 };

function renderReviewResult(res, label, targetLabel) {
  const head = [`# Claude ${label}`, "", `Target: ${targetLabel}`];
  const data = res.structured;
  if (!data || typeof data.verdict !== "string" || !Array.isArray(data.findings)) {
    head.push("Claude did not return valid structured JSON.");
    if (res.rawOutput) head.push("", "Raw final message:", "", "```text", res.rawOutput, "```");
    return head.join("\n");
  }
  const out = [...head, `Verdict: ${data.verdict}`, "", data.summary ?? "", ""];
  const findings = [...data.findings].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
  if (findings.length === 0) out.push("No material findings.");
  else {
    out.push("Findings:");
    for (const f of findings) {
      const range = !f.line_start ? "" : !f.line_end || f.line_end === f.line_start ? `:${f.line_start}` : `:${f.line_start}-${f.line_end}`;
      out.push(`- [${f.severity}] ${f.title} (${f.file}${range})`, `  ${f.body}`);
      if (f.recommendation) out.push(`  Recommendation: ${f.recommendation}`);
    }
  }
  if (data.next_steps?.length) out.push("", "Next steps:", ...data.next_steps.map((s) => `- ${s}`));
  return out.join("\n");
}

function renderNativeReviewResult(res, targetLabel) {
  const out = ["# Claude Review", "", `Target: ${targetLabel}`, ""];
  out.push(res.rawOutput?.trim() || (res.ok ? "Claude review completed without any output." : "Claude review failed."));
  return out.join("\n");
}

function renderFailure(res) {
  const out = [`Claude run failed (${res.timedOut ? "timeout" : `exit ${res.exitCode}`}).`];
  if (res.stderr) out.push("", "stderr:", "", "```text", res.stderr, "```");
  if (res.unparsedStdout) out.push("", "```text", res.unparsedStdout.slice(0, 4000), "```");
  return out.join("\n");
}

function renderStoredJobResult(job) {
  const out = [job.rendered?.trimEnd() || `# ${job.title}\n\nNo captured result payload was stored for this job.`];
  if (job.result?.permissionDenials?.length) {
    out.push("", `Denied tools: ${[...new Set(job.result.permissionDenials.map((d) => d.tool_name))].join(", ")}`);
  }
  if (job.claudeSessionId) {
    out.push("", `Claude session ID: ${job.claudeSessionId}`, `Resume in Claude: claude --resume ${job.claudeSessionId}`);
  }
  return out.join("\n");
}

// ---------- ジョブ ----------

function newJobId() {
  return `cl-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function render(job, res) {
  if (!res.ok) return renderFailure(res);
  if (job.kind === "review") return renderNativeReviewResult(res, job.targetLabel);
  if (job.kind === "adversarial-review") return renderReviewResult(res, "Adversarial Review", job.targetLabel);
  return res.rawOutput?.trim() || "Claude did not return a final message.";
}

async function executeJob(p) {
  const job = readJson(p);
  writeJson(p, { ...job, status: "running", pid: process.pid, startedAt: new Date().toISOString() });
  const res = await runClaude(job.spec, job.cwd);
  const done = readJson(p);
  if (done.status === "cancelled") return done;
  const finished = {
    ...done,
    status: res.ok ? "completed" : "failed",
    finishedAt: new Date().toISOString(),
    claudeSessionId: res.sessionId,
    result: { ok: res.ok, permissionDenials: res.permissionDenials, stderr: res.stderr },
    rendered: render(done, res),
  };
  writeJson(p, finished);
  return finished;
}

async function startJob(root, job, background) {
  const p = jobPath(root, job.id);
  writeJson(p, { ...job, status: "queued" });
  if (background) {
    const child = spawn(process.execPath, [SELF, "__run-job", p], {
      detached: true,
      stdio: "ignore",
      env: process.env,
      windowsHide: true,
    });
    child.unref();
    console.log(`Claude ${job.title} started in the background as ${job.id}.\nCheck progress: status ${job.id} --wait`);
    return;
  }
  const finished = await executeJob(p);
  console.log(renderStoredJobResult(finished));
  process.exitCode = finished.status === "completed" ? 0 : 1;
}

function guardNested(opts) {
  if (isNested() && !opts["allow-nested"]) {
    die("called from inside Claude Code; refusing to avoid Claude <-> Codex recursion (pass --allow-nested to override)");
  }
}

function baseJob(kind, title, cwd, root, spec, extra = {}) {
  return { id: newJobId(), kind, title, cwd, root, threadId: currentThreadId(), spec, createdAt: new Date().toISOString(), ...extra };
}

// ---------- コマンド ----------

function resumeCandidate(root) {
  const threadId = currentThreadId();
  const job = jobsForThread(root, threadId).find((j) => j.kind === "task" && j.claudeSessionId);
  return job ? { available: true, jobId: job.id, sessionId: job.claudeSessionId, threadScoped: !!threadId } : { available: false };
}

async function cmdTask(argv) {
  const { opts, rest } = parseArgs(argv);
  guardNested(opts);
  const cwd = path.resolve(opts.cwd || process.cwd());
  const root = workspaceRoot(cwd);
  const resumeLast = opts["resume-last"] || opts.resume;
  let prompt = readTaskPrompt(cwd, opts, rest).trim();
  if (!prompt && !resumeLast) die("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  let sessionId = null;
  if (resumeLast) {
    const c = resumeCandidate(root);
    if (!c.available) die("No previous Claude task to resume in this Codex thread.");
    sessionId = c.sessionId;
    prompt ||= RESUME_PROMPT;
  }
  const spec = { prompt, write: !!opts.write, sessionId, model: opts.model, effort: opts.effort };
  await startJob(root, baseJob("task", "Task", cwd, root, spec, { write: !!opts.write }), opts.background);
}

function cmdTaskResumeCandidate(argv) {
  const { opts } = parseArgs(argv);
  const root = workspaceRoot(path.resolve(opts.cwd || process.cwd()));
  console.log(JSON.stringify(resumeCandidate(root)));
}

async function cmdReview(argv) {
  const { opts, rest } = parseArgs(argv);
  guardNested(opts);
  // Claude の組み込みレビュー（/code-review）は対象を自分で選ぶ（未コミットがあればそれ、無ければ既定ブランチとの差）。
  // 対象の指定や重点の文は渡せないので、それが要るときは adversarial-review に回す
  if (opts.base || (opts.scope && opts.scope !== "auto")) {
    die("`review` maps directly to Claude's built-in reviewer and picks its own target. Retry with `adversarial-review --base <ref>` or `--scope` for custom targeting.");
  }
  if (rest.join(" ").trim()) {
    die(`\`review\` maps directly to Claude's built-in reviewer and does not support custom focus text. Retry with \`adversarial-review ${rest.join(" ").trim()}\` for focused review instructions.`);
  }
  const cwd = path.resolve(opts.cwd || process.cwd());
  const root = workspaceRoot(cwd);
  const spec = { prompt: "/code-review", write: false, model: opts.model, effort: opts.effort };
  const job = baseJob("review", "Review", cwd, root, spec, { targetLabel: "auto (Claude /code-review picks the working tree or the branch diff)" });
  await startJob(root, job, opts.background);
}

async function cmdAdversarialReview(argv) {
  const { opts, rest } = parseArgs(argv);
  guardNested(opts);
  const cwd = path.resolve(opts.cwd || process.cwd());
  const root = workspaceRoot(cwd);
  const target = resolveReviewTarget(root, { scope: opts.scope ?? "auto", base: opts.base ?? null });
  const context = collectReviewContext(root, target);
  if (context.empty) die(`Nothing to review for ${target.label}.`);
  const prompt = renderTemplate("adversarial-review", {
    TARGET_LABEL: target.label,
    USER_FOCUS: rest.join(" ").trim() || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.includeDiff
      ? "Use the repository context below as primary evidence."
      : "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.",
    REVIEW_INPUT: context.content,
  });
  const spec = { prompt, write: false, schemaFile: "review-output.schema.json", model: opts.model, effort: opts.effort };
  const job = baseJob("adversarial-review", "Adversarial Review", cwd, root, spec, { targetLabel: target.label });
  await startJob(root, job, opts.background);
}

function jobLine(job) {
  const dur = job.finishedAt ? `${Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt ?? job.createdAt)) / 1000)}s` : "";
  return `- ${job.id} | ${effectiveStatus(job)} | ${job.title}${job.write ? " (write)" : ""} | ${job.createdAt}${dur ? ` | ${dur}` : ""}`;
}

async function cmdStatus(argv) {
  const { opts, rest } = parseArgs(argv);
  const root = workspaceRoot(path.resolve(opts.cwd || process.cwd()));
  const id = rest[0];
  if (!id) {
    const jobs = jobsForThread(root, currentThreadId(), opts.all).slice(0, 20);
    const out = ["# Claude Status", "", `Review gate: ${getConfig(root).stopReviewGate ? "enabled" : "disabled"}`, ""];
    if (jobs.length === 0) out.push("No jobs recorded yet.");
    else out.push(...jobs.map(jobLine));
    console.log(out.join("\n"));
    return;
  }
  const p = jobPath(root, id);
  let job = loadJob(root, id) ?? die(`Unknown job: ${id}`);
  const deadline = Date.now() + Number(opts["timeout-sec"] || 240) * 1000;
  while (opts.wait && ["queued", "running"].includes(effectiveStatus(job)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    job = readJson(p);
  }
  const s = effectiveStatus(job);
  if (["completed", "failed"].includes(s)) console.log(renderStoredJobResult(job));
  else if (s === "lost") console.log(`${jobLine(job)}\nThe process running this job exited without storing a result. Start it again.`);
  else console.log(`${jobLine(job)}\nStill running. Check again: status ${id} --wait`);
}

function cmdResult(argv) {
  const { opts, rest } = parseArgs(argv);
  const root = workspaceRoot(path.resolve(opts.cwd || process.cwd()));
  const job = rest[0]
    ? loadJob(root, rest[0])
    : jobsForThread(root, currentThreadId()).find((j) => ["completed", "failed"].includes(j.status));
  if (!job) die(rest[0] ? `Unknown job: ${rest[0]}` : "No finished Claude job in this Codex thread.");
  if (!job.rendered) die(`No result yet (${effectiveStatus(job)}).`);
  console.log(renderStoredJobResult(job));
}

function terminate(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (IS_WINDOWS) {
    // Windows にプロセスグループへの kill は無い。子の claude ごと止めるには taskkill /T
    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    // __run-job は detached で起動しているのでプロセスグループごと止める（子の claude も含む）
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 既に終わっている
    }
  }
}

function cmdCancel(argv) {
  const { opts, rest } = parseArgs(argv);
  const root = workspaceRoot(path.resolve(opts.cwd || process.cwd()));
  const job = rest[0]
    ? loadJob(root, rest[0])
    : jobsForThread(root, currentThreadId()).find((j) => ["queued", "running"].includes(j.status));
  if (!job) die(rest[0] ? `Unknown job: ${rest[0]}` : "No running Claude job in this Codex thread.");
  if (!["queued", "running"].includes(job.status)) die(`Job ${job.id} is not running (${job.status}).`);
  if (job.pid) terminate(job.pid);
  writeJson(jobPath(root, job.id), { ...job, status: "cancelled", finishedAt: new Date().toISOString() });
  console.log(`# Claude Cancel\n\nCancelled ${job.id}.\n- Title: ${job.title}\n- Check the claude-status skill for the updated queue.`);
}

function cmdSetup(argv) {
  const { opts } = parseArgs(argv);
  const root = workspaceRoot(path.resolve(opts.cwd || process.cwd()));
  const actions = [];
  if (opts["enable-review-gate"] || opts["disable-review-gate"]) {
    const enable = !!opts["enable-review-gate"];
    writeJson(configPath(root), { ...getConfig(root), stopReviewGate: enable });
    actions.push(`${enable ? "Enabled" : "Disabled"} the stop-time review gate for ${root}.`);
  }
  const claude = claudeAvailability();
  const billing = BILLING_ENV.filter((k) => process.env[k]);
  const report = {
    ready: claude.available,
    node: process.version,
    claude,
    billingEnvStripped: billing,
    reviewGateEnabled: getConfig(root).stopReviewGate,
    actionsTaken: actions,
    nextSteps: claude.available ? [] : ["Run `claude auth login` (or install Claude Code), then run setup again."],
  };
  if (claude.available && claude.authMethod !== "claude.ai") {
    report.nextSteps.push(`Claude is authenticated via ${claude.authMethod}; runs may not use the subscription.`);
  }
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const out = [
    "# Claude Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node}`,
    `- claude: ${claude.version ?? claude.detail}`,
    `- auth: ${claude.available ? `${claude.authMethod}${claude.subscription ? ` (${claude.subscription})` : ""}` : claude.detail}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    `- sandbox: ${sandboxAvailable() ? "available" : "unavailable (Claude runs without Bash: no git commands, review and gate see files only)"}`,
  ];
  if (billing.length) out.push(`- billing env: ${billing.join(", ")} present; removed when launching claude`);
  if (actions.length) out.push("", "Actions taken:", ...actions.map((a) => `- ${a}`));
  if (report.nextSteps.length) out.push("", "Next steps:", ...report.nextSteps.map((s) => `- ${s}`));
  console.log(out.join("\n"));
}

// ---------- フック ----------

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function parseStopReviewOutput(text) {
  const t = String(text ?? "").trim();
  if (!t) {
    return { ok: false, reason: "The stop-time Claude review task returned no final output. Run the claude-review skill manually or bypass the gate." };
  }
  const first = t.split(/\r?\n/, 1)[0].trim();
  if (first.startsWith("ALLOW:")) return { ok: true };
  if (first.startsWith("BLOCK:")) {
    return {
      ok: false,
      reason: `Claude stop-time review found issues that still need fixes before ending the session: ${first.slice(6).trim() || t}`,
    };
  }
  return { ok: false, reason: "The stop-time Claude review task returned an unexpected answer. Run the claude-review skill manually or bypass the gate." };
}

async function cmdStopGate() {
  const input = readHookInput();
  const cwd = input.cwd || process.cwd();
  if (isNested() || git(cwd, "rev-parse", "--show-toplevel").status !== 0) return;
  const root = workspaceRoot(cwd);
  const running = jobsForThread(root, input.session_id || null).find((j) => ["queued", "running"].includes(effectiveStatus(j)));
  const runningNote = running
    ? `Claude task ${running.id} is still running. Check the claude-status skill and use the claude-cancel skill if you want to stop it before ending the session.`
    : null;
  const note = (m) => m && process.stderr.write(`${m}\n`);

  if (!getConfig(root).stopReviewGate) return note(runningNote);
  const avail = claudeAvailability();
  if (!avail.available) {
    note(`Claude is not set up for the review gate. ${avail.detail}. Run the claude-setup skill.`);
    return note(runningNote);
  }

  const last = String(input.last_assistant_message ?? "").trim();
  const prompt = renderTemplate("stop-review-gate", {
    CODEX_RESPONSE_BLOCK: last ? ["Previous Codex response:", last].join("\n") : "",
  });
  // 判定のたびに使い捨てる。続きから話すことは無いので会話を残さない
  const res = await runClaude({ prompt, write: false, persist: false }, root, { timeoutMs: STOP_REVIEW_TIMEOUT_MS });
  let review;
  if (res.timedOut) {
    review = { ok: false, reason: "The stop-time Claude review task timed out after 15 minutes. Run the claude-review skill manually or bypass the gate." };
  } else if (!res.ok) {
    const detail = (res.stderr || res.unparsedStdout || "").trim();
    review = {
      ok: false,
      reason: detail
        ? `The stop-time Claude review task failed: ${detail}`
        : "The stop-time Claude review task failed. Run the claude-review skill manually or bypass the gate.",
    };
  } else review = parseStopReviewOutput(res.rawOutput);

  if (!review.ok) {
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: runningNote ? `${runningNote} ${review.reason}` : review.reason })}\n`);
    return;
  }
  note(runningNote);
}

function cmdSessionEnd() {
  const input = readHookInput();
  const cwd = input.cwd || process.cwd();
  if (!input.session_id || git(cwd, "rev-parse", "--show-toplevel").status !== 0) return;
  const root = workspaceRoot(cwd);
  for (const job of jobsForThread(root, input.session_id)) {
    if (["queued", "running"].includes(job.status) && job.pid) terminate(job.pid);
    fs.rmSync(jobPath(root, job.id), { force: true });
  }
}

// ---------- 入口 ----------

function onFatal(e) {
  if (e?.code === "EPERM" || e?.code === "EACCES") {
    die(`cannot write ${e.path ?? ""}: running inside the Codex sandbox. Re-run outside the sandbox (escalated).`);
  }
  die(e instanceof Error ? e.message : String(e));
}
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

const [cmd, ...argv] = process.argv.slice(2);
switch (cmd) {
  case "setup":
    cmdSetup(argv);
    break;
  case "task":
    await cmdTask(argv);
    break;
  case "task-resume-candidate":
    cmdTaskResumeCandidate(argv);
    break;
  case "review":
    await cmdReview(argv);
    break;
  case "adversarial-review":
    await cmdAdversarialReview(argv);
    break;
  case "status":
    await cmdStatus(argv);
    break;
  case "result":
    cmdResult(argv);
    break;
  case "cancel":
    cmdCancel(argv);
    break;
  case "stop-gate":
    await cmdStopGate();
    break;
  case "session-end":
    cmdSessionEnd();
    break;
  case "__run-job":
    await executeJob(argv[0]);
    break;
  default:
    die("usage: claude-companion.mjs <setup|task|task-resume-candidate|review|adversarial-review|status|result|cancel> ...", 2);
}
