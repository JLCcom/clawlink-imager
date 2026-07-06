# ClawLink 클라우드 API 계약

이 문서는 ClawLink Imager가 `clawlinkai.io`(메인 `JLCcom/clawlink` repo)에서 소비하는
**공개 API**를 정리한다. 이 문서와 실제 서버 응답이 어긋나면 Imager가 조용히 고장난다 —
메인 repo 쪽에서 이 API들을 바꿀 때는 반드시 이 문서도 같이 갱신하고, 필요하면
이 repo에도 대응 이슈를 만든다.

## 1. 시리얼 검증 (Imager가 굽기 전 호출)

```
GET https://clawlinkai.io/api/v1/serials/:serial/check
```
인증 불필요(공개). Imager는 시리얼 입력 시 이걸 호출해 "오타/죽은 시리얼"만 미리 거른다 —
실제 라이선스 강제는 기기 첫 부팅의 활성화(메인 repo `docs/business/License_Policy.md` §4~5,
`POST /v1/serials/:serial/activate`)에서 일어난다.

응답:

```json
// 성공
{ "valid": true, "sku": "EO1", "status": "available" }

// 실패 (valid=false + reason)
{ "valid": false, "reason": "not_found" }
{ "valid": false, "reason": "already_activated" }
{ "valid": false, "reason": "revoked" }
{ "valid": false, "reason": "trial_expired" }
```

Imager UI는 `valid`로 유효/오류 배지를, `sku`·`status`로 힌트("유형: {sku} · 상태: {status}")를
표시한다(`src/App.js`). 응답에 없는 필드는 무시.

원본:
- 공개 경로(프록시): `JLCcom/clawlink` repo `cloud-portal/index.cjs` — `GET /api/v1/serials/:serial/check`
  → `REGISTRY_URL/v1/serials/:serial/check`
- 구현·명세 권위: `dbms/index.js` (`/v1/serials/:serial/check`) · `docs/business/License_Policy.md` §5

> 참고 — 별도 엔드포인트: `GET /api/v1/serials/:serial`(끝에 `/check` 없음)는 **Edge 설치 시
> 시리얼 직접 검증용**(#281)이며 `owner_user_id`·`device_id`·`alias` 등 더 풍부한 필드를 준다.
> Imager는 이걸 쓰지 않는다 — 혼동 주의.

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
