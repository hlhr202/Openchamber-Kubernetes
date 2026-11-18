# OpenChamber Kubernetes Explorer

[English](../../README.md) | [简体中文](README.zh-CN.md) | [العربية](README.ar.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [עברית](README.he.md) | 日本語 | [한국어](README.ko.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Português (Brasil)](README.pt-BR.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [繁體中文](README.zh-TW.md)

OpenChamber 向けの Kubernetes 拡張機能です。プロジェクトのワークスペースを離れずに、クラスターの参照、ワークロードの問題調査、一般的な Kubernetes 操作ができます。

## スクリーンショット

サンプルデータを使ったデスクトップ画面です。クラスターへの接続や操作は行っていません。画像をクリックすると原寸で表示できます。

| リソースエクスプローラー | リソースの詳細 |
| --- | --- |
| [![ワークロードの状態とカスタムリソースが表示された展開済みのリソースツリー](../screenshots/explorer.png)](../screenshots/explorer.png) | [![選択した Deployment とその YAML マニフェスト](../screenshots/resource-details.png)](../screenshots/resource-details.png) |
| **コンテナのターミナル** | **ポート転送** |
| [![選択した Pod とコンテナ、およびターミナル出力の例](../screenshots/terminal.png)](../screenshots/terminal.png) | [![選択した Service にポートの組 8080:80 が入力された転送開始前の画面](../screenshots/port-forward.png)](../screenshots/port-forward.png) |

## インストール

ビルド済みの拡張機能ファイルがリポジトリのデフォルトブランチに公開されたら、次の手順でインストールします。

1. OpenChamber の **設定 → 拡張機能** を開きます。
2. **フォルダー、ZIP、または URL** にリポジトリ URL を貼り付け、**追加** をクリックします。

   ```text
   https://github.com/hlhr202/Openchamber-Kubernetes
   ```

3. 要求されたローカルサービス権限を確認して許可し、拡張機能バーから **Kubernetes** を開きます。

ローカルでのビルドや JavaScript 依存パッケージのインストールは不要です。リポジトリが非公開の場合、OpenChamber Server に HTTPS 経由で読み取れる Git の認証情報が設定済みである必要があります。ブラウザーから GitHub にログインしても、認証情報はサーバーに渡りません。

[Docker で検証済みの候補ビルド](../status.md)には、手動インストール用のビルド済み ZIP もあります。Git URL からのインストールはまだ検証されていません。

## 前提条件

- 対象バージョンは **OpenChamber 2.5.1** です。
- OpenChamber Server を実行する OS ユーザーが、有効な **kubeconfig** を使用できること。Kubernetes API へのネットワークアクセスと、実行する操作に必要な権限も必要です。
- サーバーで **`kubectl`** が使えること。Helm CLI を呼び出す操作には **Helm** が必要です。kubeconfig が外部の認証ヘルパーを使う場合、そのヘルパーもサーバーで使える必要があります。拡張機能はこれらのツールをインストールしません。

## 機能

- Kubernetes のコンテキストや名前空間を切り替え、リソースツリーでワークロード、サービス、カスタムリソースを参照。
- リソースのマニフェスト、Pod のログ、名前空間のイベントを確認。
- マニフェストの変更を確認し、選択した対象に明示的に適用。
- 選択したコンテナーでターミナルを開く、またはポート転送を設定。
- Helm のリポジトリ、チャート、リリース、リビジョン履歴を参照。

## 作者が動作確認した範囲

作者が実際に確認したのは、リソースツリーの一覧を展開する、リソースの詳細を表示する、コンテナーのターミナルを使う、ポート転送を行う、の 4 つだけです。それ以外の操作で問題や質問があれば、[GitHub Issue を作成してください](https://github.com/hlhr202/Openchamber-Kubernetes/issues)。

## プライバシー

- 拡張機能は開発者にテレメトリーや分析用データを送信しません。サーバー側の kubeconfig と既存の権限を使い、設定済みの Kubernetes API に接続します。
- 取得したリソースデータ、ログ、ターミナル出力、未保存の下書きはメモリに保持し、ディスクには書き込みません。kubeconfig の参照元の選択など、機密性のない設定は保存しますが、kubeconfig の内容は保存しません。明示的な保存やエクスポートは別の操作です。
- Secret の値は、ユーザーが要求し、Kubernetes の権限で許可されている場合に限り表示します。クラスターデータが自動でチャットやモデルプロバイダーに送られることはありません。

この説明は本拡張機能のみに適用されます。OpenChamber、Kubernetes、併用する外部のツールやサービスは対象外です。

## ライセンス

[MIT](../../LICENSE)。同梱する依存パッケージにはそれぞれのライセンスが適用されます。ビルド済みパッケージ内の `THIRD_PARTY_NOTICES.txt` を参照してください。

[プロジェクト文書](../README.md) · [製品の対象範囲](../product.md) · [開発](../development.md)
