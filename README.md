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
| 読み取り専用・書き込みありは、Codex のサンドボックスの代わりに Claude Code のサンドボックス（`--settings` の `sandbox`）。Bash はサンドボックスの中なら何でも走らせてよく、書き込みと通信は OS の側で止める。読み取り専用では作業フォルダも書き込み禁止（`filesystem.denyWrite`） | Claude に Codex の read-only / workspace-write に当たる起動の仕方が無い。コマンドを許可リストで絞る方式は、git の参照系にも書き込み・実行のオプション（`diff --output`、`grep -O` 等）があって守れず、`/code-review` の複合コマンドも丸ごと断られる |
| `--restricted --strict-mcp-config` で起動し、ユーザー・リポジトリの settings と MCP サーバーを読まない | 読むと、その許可リスト（例: 外部サービスに書く CLI）や MCP の道具が、読むだけの実行でもそのまま使える |
| プロンプトは引数でなく標準入力で渡す | Windows のコマンドラインは 32K 文字までで、差分を埋め込むと溢れる |
| スラッシュコマンドとサブエージェント → スキル | Codex のプラグインはスキル・フック・MCP しか持てない。rescue の「薄い転送役」は Codex 本体がその場で行う |
| `AskUserQuestion` → 「ユーザーに 1 回だけ 2 択で聞く」 | Codex にその道具が無い |
| バックグラウンドは Claude Code の `run_in_background` でなく、ランタイム自身が切り離して `status --wait` で待つ | Codex のシェルに切り離し実行と完了通知が無い |
| ジョブと「続きからの再開」は Claude のセッション単位でなく Codex のスレッド単位（`CODEX_THREAD_ID`） | Codex がシェルにスレッド ID を渡す。元の SessionStart フック（セッション ID を環境に書く）は不要 |
| プロンプトの `$schema` 行を削除 | `claude --json-schema` が受け付けない |
| `/code-review` の結果は JSON の配列がそのまま本文に出る | 組み込みレビュアーの出力をそのまま返す（元の native review と同じ扱い） |
| サンドボックス外での実行（escalated）をスキルで指示、書けないときの案内 | Claude は通信と `~/.claude` への書き込みが要る。Codex 側の都合 |
| 生存確認で EPERM を「生きている」とみなす | Codex のサンドボックスから外のプロセスにシグナルを送れない |
| フックに `statusMessage` を付ける | Codex の `/hooks` はこれをフックの名前として出す。無いと「unnamed」になり見分けられない |
| `~/.local/bin/claude`（Windows は `claude.exe`、npm の `claude.cmd` は中の `cli.js`）を優先して起動 | シェルのラッパー（cmux）が `claude` を横取りする環境がある |

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

## Windows（未検証）

macOS でだけ動作を確かめている。Windows 向けに次の手当てはしてあるが、**実機では一度も動かしていない**。

- フックは `commandWindows` で、シェルの変数展開（`$PLUGIN_ROOT` / `%PLUGIN_ROOT%`）に頼らず node が環境変数を読む形にした。
  `PLUGIN_ROOT` が無い・相対パスのときは何もせず終わる（リポジトリに置かれたファイルを読み込まないため）。
  Windows で Codex がフックをどのシェルで動かすか、`PLUGIN_ROOT` が環境変数として渡るかは公式の説明に書かれていない
- `claude.exe`・`git.exe` は PATH の絶対パスの場所だけから探して絶対パスで起動し、見つからなければ止める
  （Windows は名前だけで起動すると作業フォルダを先に探すので、リポジトリに置かれた偽物が動く）。`taskkill` は System32 のもの
- npm で入れた `claude.cmd` は Node がシェル無しで起動しないので、隣の `node_modules/@anthropic-ai/claude-code/cli.js` を node で起動する（npm の版の中身が変わっていれば動かない）
- `cancel` とセッション終了の片付けは `taskkill /T /F` で子の claude ごと止める
- バックグラウンド実行と claude の起動は `windowsHide` でコンソールの窓を出さない
- **Claude Code のサンドボックスが使えない環境（Windows、bubblewrap・socat の無い Linux）では Claude に Bash を渡さない。**
  渡すと読むだけの実行でも書き込みが止まらないため。その代わり git が使えないので、組み込みレビュー（`/code-review`）と
  Stop ゲートは差分を見られずファイルの中身だけで判断する。adversarial-review は差分をプロンプトに埋め込むので、
  2 ファイル・256KB までなら差分を見られる。`claude-setup` の `sandbox:` の行で分かる

## Stop ゲート

`claude-setup` で `--enable-review-gate`（既定はオフ、リポジトリごと）。元と同じく:

- オンなら Codex のターンの終わりに毎回 Claude を呼ぶ。コードを変えていないターンはプロンプトの指示で即 ALLOW
- 1 行目が `BLOCK:` なら `{"decision":"block"}` を返し、Codex はその理由を次の指示として続ける
- Claude の失敗・時間切れ（15 分）・想定外の答えも止める側に倒す。Claude が未導入・未ログインならゲートは動かず注意だけ出す
- 走っている Claude のジョブがあれば知らせる

フックは信頼するまで動かない（CLI は `/hooks`）。中身のハッシュで覚えるので、プラグインを更新するたびに信頼し直す。

## 入れ方

### 前提

- Claude Code が入っていてログイン済み（`claude auth status` で `loggedIn: true`）
- Node.js（ランタイムは依存なしの `.mjs`）
- macOS で確認済み。Windows は未検証（下の「Windows（未検証）」）
- ターミナルの `codex` とデスクトップアプリ（ChatGPT.app 同梱の codex）の版を揃えておく。
  版が違うとフックの信頼のハッシュの形が違い、片方で信頼してももう片方に効かないことがある。
  brew で入れているなら `brew upgrade --cask codex`

### 1. マーケットプレイスを登録してプラグインを入れる

```bash
codex plugin marketplace add ~/Dev/personal/codex-claude-plugin
```

```bash
codex plugin add claude@codex-claude
```

`codex plugin list` で `claude@codex-claude  installed, enabled` と出れば入っている。
デスクトップアプリは起動中に入れたプラグインを読まないので、Cmd+Q で終了して開き直す。

### 2. 動くか確かめる

Codex で「Claude の準備ができているか確かめて」と頼む（`claude-setup`）。`Status: ready` と
`auth: claude.ai (…)` が出ればよい。`claude.ai` 以外ならサブスク以外で動く可能性がある。

### 3. フックを信頼する（Stop ゲートを使うときだけ）

フックは信頼するまで動かない。ターミナルで `codex` を開き、`/hooks` で次の 2 つを信頼する。

- Claude が変更を確認しています（レビューゲート）
- Claude のジョブを片付けています

デスクトップアプリの「設定 > フック」にはプラグインのフックが出ないことがある（2026-11 時点）。
信頼の記録は共通（`~/.codex/config.toml` の `[hooks.state]`）なので、ターミナルで信頼すればアプリにも効く。

### 4. Stop ゲートをオンにする（任意）

ゲートはリポジトリごとで、既定はオフ。そのリポジトリで Codex に「Claude のレビューゲートをオンにして」と頼む
（`claude-setup` が `setup --enable-review-gate` を流す）。オフは `--disable-review-gate`。

### 使い方

| 頼み方の例 | スキル |
|---|---|
| 「Claude にこのバグの原因を調べて直してもらって」「さっきの続きを Claude に」 | `claude-rescue` |
| 「Claude にレビューさせて」 | `claude-review`（組み込みの `/code-review`） |
| 「Claude に設計を疑う目でレビューさせて」「main との差分を Claude に厳しく見せて」 | `claude-adversarial-review` |
| 「Claude のジョブはどうなった」「結果を見せて」「止めて」 | `claude-status` / `claude-result` / `claude-cancel` |

Claude の呼び出しは通信と `~/.claude` への書き込みが要るので、Codex はサンドボックス外での実行の承認を求める。
毎回の承認を避けたいなら、書き込み先とネットワークだけ開けた workspace-write でも動く:

```bash
codex -s workspace-write -c sandbox_workspace_write.network_access=true \
  --add-dir ~/.local/state/codex-claude --add-dir ~/.claude
```

### 直したとき

Codex は `~/.codex/plugins/cache/codex-claude/claude/<version>/` に写して使うので、元を直しても反映されない。
`plugin.json` の `version` を上げてから入れ直す:

```bash
codex plugin remove claude@codex-claude && codex plugin add claude@codex-claude
```

フックかスクリプトが変わると、フックは「変更あり」になり、3. の信頼をやり直す必要がある。

## ライセンス

Apache License 2.0（`LICENSE`）。元の openai/codex-plugin-cc の表示と変更の内容は `NOTICE` にある。
