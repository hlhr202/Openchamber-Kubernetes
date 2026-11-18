# OpenChamber Kubernetes Explorer

[English](../../README.md) | [简体中文](README.zh-CN.md) | [العربية](README.ar.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [עברית](README.he.md) | [日本語](README.ja.md) | 한국어 | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Português (Brasil)](README.pt-BR.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [繁體中文](README.zh-TW.md)

OpenChamber용 Kubernetes 확장입니다. 프로젝트 작업 공간에서 클러스터를 둘러보고, 워크로드 문제를 조사하고, 일반적인 Kubernetes 작업을 수행할 수 있습니다.

## 스크린샷

예시 데이터로 만든 데스크톱 화면입니다. 클러스터에 연결하거나 작업을 실행하지 않았습니다. 스크린샷을 클릭하면 원본 크기로 볼 수 있습니다.

| 리소스 탐색기 | 리소스 세부 정보 |
| --- | --- |
| [![워크로드 상태와 사용자 정의 리소스가 표시된 펼쳐진 리소스 트리](../screenshots/explorer.png)](../screenshots/explorer.png) | [![선택한 Deployment와 해당 YAML 매니페스트](../screenshots/resource-details.png)](../screenshots/resource-details.png) |
| **컨테이너 터미널** | **포트 포워딩** |
| [![선택한 Pod와 컨테이너 및 터미널 출력 예시](../screenshots/terminal.png)](../screenshots/terminal.png) | [![포워딩 시작 전 선택한 Service에 8080:80 매핑이 입력된 화면](../screenshots/port-forward.png)](../screenshots/port-forward.png) |

## 설치

미리 빌드된 확장 파일이 저장소의 기본 브랜치에 게시되면 다음과 같이 설치합니다.

1. OpenChamber에서 **설정 → 확장**을 엽니다.
2. **폴더, ZIP 또는 URL** 입력란에 저장소 URL을 붙여 넣고 **추가**를 클릭합니다.

   ```text
   https://github.com/hlhr202/Openchamber-Kubernetes
   ```

3. 요청된 로컬 서비스 권한을 확인하고 허용한 뒤, 확장 도구 모음에서 **Kubernetes**를 엽니다.

로컬 빌드나 JavaScript 의존성 설치는 필요하지 않습니다. 저장소가 비공개인 동안에는 OpenChamber Server에 HTTPS로 읽을 수 있는 Git 자격 증명이 이미 설정되어 있어야 합니다. 브라우저에서 GitHub에 로그인해도 해당 자격 증명이 서버에 전달되지 않습니다.

[Docker에서 검증한 후보 빌드](../status.md)는 수동 설치용 ZIP으로도 제공됩니다. Git URL을 통한 설치는 아직 검증되지 않았습니다.

## 사전 요구 사항

- 이 확장은 **OpenChamber 2.5.1**을 대상으로 합니다.
- OpenChamber Server를 실행하는 운영체제 사용자가 정상적인 **kubeconfig**를 사용할 수 있어야 합니다. Kubernetes API에 대한 네트워크 접근과 수행할 작업에 필요한 권한도 필요합니다.
- 서버에서 **`kubectl`**을 사용할 수 있어야 합니다. Helm CLI를 호출하는 작업에는 **Helm**이 필요합니다. kubeconfig에서 외부 자격 증명 도우미를 사용한다면 서버에 해당 도우미도 있어야 합니다. 확장이 이러한 도구를 설치하지는 않습니다.

## 기능

- Kubernetes 컨텍스트와 네임스페이스를 전환하고 리소스 트리에서 워크로드, 서비스, 사용자 정의 리소스를 탐색합니다.
- 리소스 매니페스트, Pod 로그, 네임스페이스 이벤트를 확인합니다.
- 매니페스트 변경 사항을 검토하고 선택한 대상에 명시적으로 적용합니다.
- 선택한 컨테이너의 터미널을 열거나 포트 포워딩을 설정합니다.
- Helm 저장소, 차트, 릴리스, 리비전 이력을 둘러봅니다.

## 작성자가 직접 테스트한 범위

작성자가 직접 테스트한 것은 리소스 트리에서 목록 펼치기, 리소스 세부 정보 보기, 컨테이너 터미널 사용, 포트 포워딩의 네 가지뿐입니다. 다른 작업에서 문제가 발생하거나 궁금한 점이 있으면 [GitHub 이슈를 열어 주세요](https://github.com/hlhr202/Openchamber-Kubernetes/issues).

## 개인정보 보호

- 확장은 개발자에게 텔레메트리나 분석 데이터를 보내지 않습니다. 서버의 kubeconfig와 기존 권한을 사용해 설정된 Kubernetes API에 연결합니다.
- 가져온 리소스 데이터, 로그, 터미널 출력, 저장하지 않은 초안은 메모리에만 보관하며 디스크에 쓰지 않습니다. kubeconfig 소스 선택 등 민감하지 않은 설정만 저장하고 kubeconfig 내용은 저장하지 않습니다. 명시적인 저장과 내보내기는 별도 작업입니다.
- Secret 값은 사용자가 요청하고 Kubernetes 권한이 허용하는 경우에만 표시됩니다. 클러스터 데이터는 채팅이나 모델 제공업체에 자동으로 전송되지 않습니다.

이 설명은 이 확장에만 적용되며 OpenChamber, Kubernetes 또는 함께 사용하는 외부 도구와 서비스에는 적용되지 않습니다.

## 라이선스

[MIT](../../LICENSE). 포함된 의존성에는 각자의 라이선스가 적용됩니다. 미리 빌드된 패키지의 `THIRD_PARTY_NOTICES.txt`를 참고하세요.

[프로젝트 문서](../README.md) · [제품 범위](../product.md) · [개발](../development.md)
