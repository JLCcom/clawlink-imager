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

## 2. OS 이미지 다운로드 — 공개 GHCR OCI 아티팩트

> **2026-07-09 변경(#31).** 옛 `https://clawlinkai.io/dist/os/…` HTTP 경로는 **폐기**됐다
> (메인 repo #712 — "배포=GHCR 전용"). 그 URL은 지금도 404가 아니라 **200으로 빈
> 플레이스홀더**(`"updated":"placeholder"`, 모든 보드 `available:false`)를 돌려주므로,
> 계속 보고 있으면 에러 없이 조용히 "굽을 이미지가 없음"이 된다. 절대 되돌리지 말 것.

이미지는 **공개(익명 pull 가능) GHCR OCI 아티팩트**로 게시된다:

```
ghcr.io/jlccom/clawlink-edge-os:latest          (= :r<height>.g<short>)
artifactType: application/vnd.clawlink.osimage
```

### 2.1 받는 법 (oras 불필요 — 순수 HTTPS)

`oras` 바이너리를 번들할 필요가 없다. 구현은 `src/ghcr.js`.

1. **익명 토큰** — public repo 라도 토큰 없이 호출하면 401이다. 로그인은 필요 없다.
   ```
   GET https://ghcr.io/token?scope=repository:jlccom/clawlink-edge-os:pull&service=ghcr.io
   → { "token": "...", "expires_in": 300 }
   ```
2. **매니페스트** — `Authorization: Bearer <token>`, `Accept: application/vnd.oci.image.manifest.v1+json`
   ```
   GET https://ghcr.io/v2/jlccom/clawlink-edge-os/manifests/latest
   ```
3. **블롭** — `GET https://ghcr.io/v2/jlccom/clawlink-edge-os/blobs/<digest>`
   → **307 리다이렉트**로 `pkg-containers.githubusercontent.com` 서명 URL로 넘어간다.
   리다이렉트를 직접 따라가야 하고, **호스트가 바뀌면 `Authorization` 헤더를 떼야 한다**
   (서명 URL에 이미 권한이 실려 있다).

### 2.2 아티팩트 구성

레이어는 `org.opencontainers.image.title` 주석으로 구분한다:

| title | 용도 |
|---|---|
| `clawlinkos-opizero3-<YYYYMM>.img.xz` | 실제 이미지 (~275MB) |
| `clawlinkos-opizero3-<YYYYMM>.img.xz.sha256` | 해시 (교차확인용) |
| `releases.json` | 버전·OS 베이스·포함 도커 이미지 목록 |
| `RELEASE_NOTES.md` | 릴리즈 노트 |

매니페스트 주석: `io.clawlink.board` · `io.clawlink.os_version` · `io.clawlink.built` ·
`org.opencontainers.image.version` · `org.opencontainers.image.revision`.

### 2.3 무결성 검증

**블롭 주소가 곧 그 파일의 sha256이다** — `blobs/sha256:<hex>` 의 `<hex>`가 받은 바이트의
해시와 같아야 한다. 받으면서 해시를 계산해 대조하면 검증이 끝난다(동봉된 `.sha256`
파일 내용도 정확히 같은 값이라, 교차확인용으로만 쓴다).

### 2.4 발행 범위

현재 **EO1(`opizero3`) 하나만** 발행된다. `rpi3/rpi4/rpi5/opizero2w`는 아직 이미지가 없어
UI에서 "(준비 중)"으로 표시된다.

원본: `JLCcom/clawlink` repo `scripts/release-edge-os-image.sh` ·
권위 문서 `docs/common/ops/Common_Ops_Image_Registry.md §5.5`.

## 3. 변경 시 절차

- 메인 repo에서 이 두 API의 응답 필드를 추가하는 건 안전(하위 호환) — Imager는 모르는
  필드는 무시.
- 필드를 **제거**하거나 **의미를 바꾸면** Imager가 깨진다 — 반드시 메인 repo에 이슈를
  만들고 이 문서 갱신 + 이 repo에도 대응 이슈 생성.
