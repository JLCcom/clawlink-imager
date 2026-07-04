# ClawLink 클라우드 API 계약

이 문서는 ClawLink Imager가 `clawlinkai.io`(메인 `JLCcom/clawlink` repo)에서 소비하는
**공개 API**를 정리한다. 이 문서와 실제 서버 응답이 어긋나면 Imager가 조용히 고장난다 —
메인 repo 쪽에서 이 API들을 바꿀 때는 반드시 이 문서도 같이 갱신하고, 필요하면
이 repo에도 대응 이슈를 만든다.

## 1. 시리얼 검증

```
GET https://clawlinkai.io/api/v1/serials/:serial
```
인증 불필요(공개). 응답:

```json
{
  "valid": true,
  "serial": "CL-EO1-260600-000123",
  "model": "eo1",
  "owner_user_id": "someuser",
  "device_id": "abc123...",
  "alias": "우리집 엣지",
  "alias_updated_at": "2026-07-01T00:00:00Z",
  "claimed": true
}
```

미등록 시리얼이면 HTTP 404 + `{"valid": false, "serial": "...", "reason": "serial_not_registered", "guide": "..."}`.

원본: `JLCcom/clawlink` repo `dbms/handlers/cloud-claim.js` (`GET /v1/serials/:serial`).

## 2. OS 이미지 다운로드

```
GET https://clawlinkai.io/dist/os/manifest.json
```
응답:
```json
{
  "updated": "20260704",
  "boards": [
    { "board": "rpi4", "hw_model": "Raspberry Pi 4", "file": "clawlinkos-rpi4-20260704.img.xz",
      "date": "20260704", "sha256": "..." }
  ]
}
```
이미지 파일 자체: `GET https://clawlinkai.io/dist/os/<file>` (정적 파일, `boards[].file` 값 그대로).

원본: `JLCcom/clawlink` repo `cloud-portal/index.cjs`(`/dist/os/manifest.json` 라우트) +
`scripts/build-clawlinkos-image.sh`(manifest 생성).

## 3. 변경 시 절차

- 메인 repo에서 이 두 API의 응답 필드를 추가하는 건 안전(하위 호환) — Imager는 모르는
  필드는 무시.
- 필드를 **제거**하거나 **의미를 바꾸면** Imager가 깨진다 — 반드시 메인 repo에 이슈를
  만들고 이 문서 갱신 + 이 repo에도 대응 이슈 생성.
