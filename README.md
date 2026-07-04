# ClawLink Imager

ClawLink OS 이미지를 SD카드에 구워주는 데스크탑 앱(Electron+React). Windows/macOS/Linux
지원 목표. Raspberry Pi Imager · balenaEtcher와 같은 개념의 범용 도구 — 오픈소스.

`JLCcom/clawlink`(메인 코어 repo)와는 별개 repo — 이미지(OS)는 메인 repo가 만들고,
이 앱은 그 이미지를 다운로드해서 SD카드에 쓰는 역할만 한다. 둘 사이는 안정된 공개
API로만 연결된다: [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) 참고.

## 개발

```bash
npm install
npm start        # Electron + React 개발 서버
npm run electron:build:linux   # 플랫폼별 빌드 (win/mac/linux)
```

## 진행 상태

`JLCcom/clawlink` repo 이슈 [#485](https://github.com/JLCcom/clawlink/issues/485)
(에픽)가 진행 상태 진리원. 실제 SD 굽기 등 핵심 기능은 아직 실기기 검증 전 —
과대광고 금지 원칙에 따라 미검증 기능은 문서에 "(개발중)"으로 표기.

## 개발 규칙

이 repo에서 작업하기 전 [이슈 #1](https://github.com/JLCcom/clawlink-imager/issues/1)
(pinned)을 먼저 읽는다 — AI 세션은 SessionStart 훅으로 자동 로드됨.
