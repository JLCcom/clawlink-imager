#!/usr/bin/env bash
# clawlink-burn.sh — root 권한이 필요한 일만 모아 둔 스크립트 (#9).
#
# 이미저 본체는 일반 권한으로 돌고, 이 스크립트만 pkexec(Linux) / osascript(macOS)로
# 한 번 승격해서 실행한다. 승격 프롬프트를 한 번만 띄우려고 "SD 쓰기 + 설정 주입"을
# 여기 묶어 뒀다 — 두 단계를 따로 승격하면 사용자가 암호를 두 번 넣어야 한다.
#
# 인자: <이미지경로> <디스크> <파티션번호|빈문자열> <clawlink.conf 경로>
#   파티션번호가 빈 문자열이면 이미지만 쓰고 주입은 건너뛴다(설정 파티션이 없는 이미지).
#
# 진행 상황은 stderr 로 `CLPHASE <단계>` / dd 의 진행 출력으로 나간다 — main.js 가 읽는다.
set -euo pipefail

IMAGE="${1:?이미지 경로 없음}"
DISK="${2:?디스크 경로 없음}"
PART_NUM="${3-}"
CONF="${4-}"

OS="$(uname)"

# 리눅스는 mmcblk0 → mmcblk0p2, sdb → sdb2. 맥은 disk2 → disk2s2.
partition_node() {
  if [[ "$OS" == "Darwin" ]]; then
    echo "${DISK}s${1}"
  elif [[ "$DISK" =~ [0-9]$ ]]; then
    echo "${DISK}p${1}"
  else
    echo "${DISK}${1}"
  fi
}

# EXIT 트랩이 0 이 아닌 값으로 끝나면 스크립트 종료 코드까지 그걸로 바뀐다 — 성공한 굽기가
# 실패로 보고된다. 반드시 0 으로 끝낸다.
cleanup() {
  if [[ -n "${MNT:-}" && -d "$MNT" ]]; then
    umount "$MNT" 2>/dev/null || true
    rmdir "$MNT" 2>/dev/null || true
  fi
  return 0
}
trap cleanup EXIT

# ── 1. SD 쓰기 ────────────────────────────────────────────────────────────────
echo "CLPHASE writing" >&2

WRITE_TO="$DISK"
if [[ "$OS" == "Darwin" ]]; then
  # 맥은 굽기 전에 볼륨을 내려야 하고, 버퍼드(/dev/diskN)보다 raw(/dev/rdiskN)가 훨씬 빠르다.
  diskutil unmountDisk "$DISK" >&2 || true
  WRITE_TO="${DISK/\/dev\/disk//dev/rdisk}"
fi

# 맥 dd(BSD)와 busybox dd 는 status=progress 를 모른다. 지원할 때만 붙인다 —
# 안 그러면 dd 가 인자 오류로 죽어서 굽기 자체가 실패한다.
if [[ "$OS" == "Darwin" ]]; then
  DD_OPTS=(bs=4m)
elif dd --help 2>&1 | grep -q progress; then
  DD_OPTS=(bs=4M status=progress)
else
  DD_OPTS=(bs=4M)
fi

if [[ "$IMAGE" == *.xz ]]; then
  xz -dc -- "$IMAGE" | dd of="$WRITE_TO" "${DD_OPTS[@]}"
else
  dd if="$IMAGE" of="$WRITE_TO" "${DD_OPTS[@]}"
fi
sync

# ── 2. 설정 주입 ──────────────────────────────────────────────────────────────
if [[ -z "$PART_NUM" || -z "$CONF" ]]; then
  echo "CLPHASE done" >&2
  exit 0
fi

echo "CLPHASE injecting" >&2

PART="$(partition_node "$PART_NUM")"

if [[ "$OS" == "Darwin" ]]; then
  MNT="$(mktemp -d)"
  diskutil unmountDisk "$DISK" >&2 || true
  mount -t msdos "$PART" "$MNT"
else
  # 방금 dd 로 파티션 테이블이 바뀌었다 — 커널이 다시 읽게 하고 노드가 나타날 때까지 기다린다.
  blockdev --rereadpt "$DISK" 2>/dev/null || true
  command -v udevadm >/dev/null 2>&1 && udevadm settle 2>/dev/null || sleep 2

  for _ in $(seq 1 20); do
    [[ -b "$PART" ]] && break
    sleep 0.5
  done
  [[ -b "$PART" ]] || { echo "설정 파티션 $PART 가 나타나지 않았습니다." >&2; exit 1; }

  MNT="$(mktemp -d)"
  mount -t vfat "$PART" "$MNT"
fi

cp -- "$CONF" "$MNT/clawlink.conf"
sync

echo "CLPHASE done" >&2
