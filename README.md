# codex-claude-plugin

Codex から Claude Code を呼ぶための Codex プラグイン。
Claude Code 用の [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)（Claude から Codex を呼ぶ）を、
役割を入れ替えて写したもの。**プロンプト・スキル・ゲートの動きは元のまま**にし、Codex と Claude Code の
仕組みの違いで変えざるを得ない所だけ変えている（下の表）。

## 中身

| 置き場所 | 元のプラグインでは |
|---|---|
| `plugins/claude/skills/claude-rescue` | `/codex:rescue` ＋ `codex-rescue` サブエージェント ＋ `codex-cli-runtime` スキル |
| `plugins/claude/skills/claude-review` | `/codex:review` |
| `plugins/claude/skills/claude-adversarial-review` | `/codex:adversarial-review` |
| `plugins/claude/skills/claude-status` / `claude-result` / `claude-cancel` | `/codex:status` / `/codex:result` / `/codex:cancel` |
| `plugins/claude/skills/claude-setup` | `/codex:setup`（ゲートのオン・オフもここ） |
| `plugins/claude/skills/claude-result-handling` | `codex-result-handling` スキル |
| `plugins/claude/prompts/adversarial-review.md` / `stop-review-gate.md` | 同名のプロンプト |
| `plugins/claude/schemas/review-output.schema.json` | 同名のスキーマ |
| `plugins/claude/hooks/hooks.json` | Stop（レビューゲート）と SessionEnd（ジョブの片付け） |
| `plugins/claude/scripts/claude-companion.mjs` | `codex-companion.mjs` ＋ フックのスクリプト |

## 元のプラグインとの違い

### 仕組みの違いで変えたもの

| 違い | 理由 |
|---|---|
| `codex app-server` の代わりに `claude -p --output-format json`、続きは `--resume <session_id>` | Claude Code に常駐のアプリサーバーが無い |
| `/codex:review`（Codex の組み込みレビュアー）→ Claude の組み込み `/code-review` | 「組み込みのレビュアーをそのまま呼ぶ」に当たる物。対象は `/code-review` が自分で選ぶ（未コミットがあればそれ、無ければ既定ブランチとの差）ので、`--base` / `--scope` は受け付けず adversarial-review に回す |
| 読み取り専用は Codex のサンドボックスでなく `--permission-mode dontAsk` ＋ 許可する道具の一覧 | Claude にサンドボックスの read-only が無い。参照系の git と Read/Grep/Glob だけ許すので、Codex の read-only と違い**コードを実行して確かめることはできない**（`Denied tools: Bash` と出る） |
| `--write` は `acceptEdits` ＋ 編集系の道具を許可 | 同上（Codex の workspace-write に当たる物） |
| スラッシュコマンドとサブエージェント → スキル | Codex のプラグインはスキル・フック・MCP しか持てない。rescue の「薄い転送役」は Codex 本体がその場で行う |
| `AskUserQuestion` → 「ユーザーに 1 回だけ 2 択で聞く」 | Codex にその道具が無い |
| バックグラウンドは Claude Code の `run_in_background` でなく、ランタイム自身が切り離して `status --wait` で待つ | Codex のシェルに切り離し実行と完了通知が無い |
| ジョブと「続きからの再開」は Claude のセッション単位でなく Codex のスレッド単位（`CODEX_THREAD_ID`） | Codex がシェルにスレッド ID を渡す。元の SessionStart フック（セッション ID を環境に書く）は不要 |
| プロンプトの `$schema` 行を削除 | `claude --json-schema` が受け付けない |
| `/code-review` の結果は JSON の配列がそのまま本文に出る | 組み込みレビュアーの出力をそのまま返す（元の native review と同じ扱い） |
| サンドボックス外での実行（escalated）をスキルで指示、書けないときの案内 | Claude は通信と `~/.claude` への書き込みが要る。Codex 側の都合 |
| 生存確認で EPERM を「生きている」とみなす | Codex のサンドボックスから外のプロセスにシグナルを送れない |
| フックに `statusMessage` を付ける | Codex の `/hooks` はこれをフックの名前として出す。無いと「unnamed」になり見分けられない |
| `~/.local/bin/claude` を優先して起動 | シェルのラッパー（cmux）が `claude` を横取りする環境がある |

### 私たちの判断で足したもの

| 足したもの | 理由 |
|---|---|
| `ANTHROPIC_API_KEY` などを外して起動 | 環境に API キーがあると `claude -p` が黙って従量課金になる |
| `CLAUDE_CODE_ENTRYPOINT` を外して起動 | 起動元のアプリの履歴に会話が混ざる |
| Stop ゲートの判定は会話を保存しない（`--no-session-persistence`） | 判定は使い捨てで、ターンごとにファイルが溜まる |
| Claude Code の中から呼ばれたら止まる | このマシンには元のプラグインも入っており、Claude ↔ Codex で呼び合う |

### 移していないもの

- `/codex:transfer`（会話の引き継ぎ）: Codex の会話を Claude のセッションに取り込む口が無い
- `gpt-5-4-prompting` スキル: GPT 向けの書き方なので写せない。Claude 向けを新しく書くことになる
- app-server のブローカー（常駐の接続）: 上の理由で不要

## Stop ゲート

`claude-setup` で `--enable-review-gate`（既定はオフ、リポジトリごと）。元と同じく:

- オンなら Codex のターンの終わりに毎回 Claude を呼ぶ。コードを変えていないターンはプロンプトの指示で即 ALLOW
- 1 行目が `BLOCK:` なら `{"decision":"block"}` を返し、Codex はその理由を次の指示として続ける
- Claude の失敗・時間切れ（15 分）・想定外の答えも止める側に倒す。Claude が未導入・未ログインならゲートは動かず注意だけ出す
- 走っている Claude のジョブがあれば知らせる

フックは信頼するまで動かない（CLI は `/hooks`）。中身のハッシュで覚えるので、プラグインを更新するたびに信頼し直す。

## 入れ方

```bash
codex plugin marketplace add ~/Dev/personal/codex-claude-plugin
codex plugin add claude@codex-claude
```

直したときは `codex plugin remove claude@codex-claude && codex plugin add claude@codex-claude`
（Codex は `~/.codex/plugins/cache/` に写して使うので、元を直しても反映されない）。

毎回のサンドボックス外の承認を避けたいなら、書き込み先とネットワークだけ開けた workspace-write でも動く:

```bash
codex -s workspace-write -c sandbox_workspace_write.network_access=true \
  --add-dir ~/.local/state/codex-claude --add-dir ~/.claude
```

## ライセンス

Apache License 2.0（`LICENSE`）。元の openai/codex-plugin-cc の表示と変更の内容は `NOTICE` にある。
