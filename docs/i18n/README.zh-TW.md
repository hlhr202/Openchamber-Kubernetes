# OpenChamber Kubernetes Explorer

[English](../../README.md) | [简体中文](README.zh-CN.md) | [العربية](README.ar.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [עברית](README.he.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Português (Brasil)](README.pt-BR.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | 繁體中文

適用於 OpenChamber 的 Kubernetes 擴充功能。你可以在專案工作區內瀏覽叢集、排查工作負載問題，以及執行常用的 Kubernetes 操作。

## 螢幕截圖

桌面預覽使用模擬資料，未連線至叢集或執行操作。點選截圖可檢視原始大小。

| 資源瀏覽器 | 資源詳細資料 |
| --- | --- |
| [![展開的資源樹，顯示工作負載狀態和自訂資源](../screenshots/explorer.png)](../screenshots/explorer.png) | [![選取的 Deployment 及其 YAML 資訊清單](../screenshots/resource-details.png)](../screenshots/resource-details.png) |
| **容器終端機** | **連接埠轉送** |
| [![選取的 Pod 和容器，以及範例終端機輸出](../screenshots/terminal.png)](../screenshots/terminal.png) | [![為選取的 Service 預填 8080:80，尚未開始轉送](../screenshots/port-forward.png)](../screenshots/port-forward.png) |

## 安裝

擴充功能的預先建置檔案發佈至存放庫的預設分支後：

1. 在 OpenChamber 中開啟 **設定 → 擴充功能**。
2. 將存放庫網址貼到 **資料夾、ZIP 或 URL** 欄位，按一下 **新增**：

   ```text
   https://github.com/hlhr202/Openchamber-Kubernetes
   ```

3. 檢查並允許擴充功能要求的本機服務權限，再從擴充功能側欄開啟 **Kubernetes**。

不需要在本機建置或安裝 JavaScript 相依套件。如果存放庫為私人存放庫，OpenChamber Server 必須已具備透過 HTTPS 讀取它的 Git 憑證。在瀏覽器登入 GitHub 不會把憑證提供給伺服器。

[通過 Docker 驗證的候選版本](../status.md)也提供可手動安裝的預先建置 ZIP。透過 Git URL 安裝尚未驗證。

## 先決條件

- 本擴充功能以 **OpenChamber 2.5.1** 為目標版本。
- 執行 OpenChamber Server 的作業系統使用者須能使用有效的 **kubeconfig**、存取 Kubernetes API，並具備所需操作的權限。
- 伺服器須已有 **`kubectl`**。呼叫 Helm CLI 的操作需要 **Helm**。如果 kubeconfig 使用外部憑證輔助程式，伺服器也必須有該程式。擴充功能不會安裝這些工具。

## 功能

- 切換 Kubernetes context 與命名空間，並在資源樹中瀏覽工作負載、服務及自訂資源。
- 檢視資源資訊清單、讀取 Pod 記錄及查看命名空間事件。
- 檢查資訊清單的變更，再手動套用至選定的目標。
- 開啟所選容器的終端機，或設定連接埠轉送。
- 瀏覽 Helm 存放庫、Chart、Release 及修訂記錄。

## 作者親自測試的範圍

作者只親自測試過四種用法：展開資源樹中的資源清單、檢視資源詳細資料、使用容器終端機，以及設定連接埠轉送。使用其他功能時如有疑問或遇到問題，歡迎[開立 GitHub Issue](https://github.com/hlhr202/Openchamber-Kubernetes/issues)。

## 隱私權

- 擴充功能不會將遙測或分析資料傳送給開發者。它使用伺服器端的 kubeconfig，以你現有的權限連線至已設定的 Kubernetes API。
- 取得的資源資料、記錄、終端機輸出和未儲存的草稿只保留在記憶體中，不會寫入磁碟。擴充功能會保留 kubeconfig 來源選擇等非敏感偏好，但不會儲存 kubeconfig 的內容。手動儲存或匯出是獨立操作。
- 只有你明確要求且具備對應的 Kubernetes 權限時，才會顯示 Secret 的值。叢集資料不會自動傳送至聊天或模型供應商。

本聲明僅適用於此擴充功能，不涵蓋 OpenChamber、Kubernetes 或你所使用的外部工具和服務。

## 授權

[MIT](../../LICENSE)。隨附的相依套件保有各自的授權，請見預先建置套件中的 `THIRD_PARTY_NOTICES.txt`。

[專案文件](../README.md) · [產品範圍](../product.md) · [開發文件](../development.md)
