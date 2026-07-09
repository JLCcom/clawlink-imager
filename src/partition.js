// partition.js — SD카드에서 설정을 쓸 FAT 파티션을 찾는다 (#30).
//
// 보드마다 파티션 배치가 다르다: RPi 는 FAT boot + ext4 rootfs 두 개고, Allwinner(opizero3)는
// u-boot 가 SD raw 오프셋에 있어 FAT boot 파티션이 아예 없다. "1번 파티션이 boot"라고 가정하면
// 안 되고 파일시스템으로 찾아야 한다. 못 찾으면 조용히 엉뚱한 곳(ext4 rootfs 루트)에 쓰는 대신
// 실패해야 한다 — 그렇게 쓰면 보드가 켜지긴 하는데 활성화가 안 되는, 제일 헷갈리는 실패가 된다.
//
// lsblk/blkid 출력에 기대지 않고 MBR과 FAT 부트섹터를 직접 읽는다. 두 도구 모두 udev
// 데이터베이스에 의존해서, udev 가 없는 환경에선 파일시스템 종류를 빈 값으로 준다.
// 직접 읽으면 블록 디바이스든 이미지 파일이든 똑같이 동작한다.
const fs = require('fs');

const CONFIG_PART_LABEL = 'CLAWLINK';
const SECTOR = 512;

// MBR 파티션 타입 중 FAT 계열
const FAT_PART_TYPES = new Set([
  0x01, // FAT12
  0x04, // FAT16 <32MB
  0x06, // FAT16
  0x0b, // FAT32
  0x0c, // FAT32 (LBA)
  0x0e, // FAT16 (LBA)
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** MBR(첫 섹터)에서 파티션 항목 4개를 읽는다. 디스크 순서가 아니라 테이블 순서 그대로. */
function parseMbr(sector0) {
  if (sector0.length < SECTOR) return [];
  if (sector0[510] !== 0x55 || sector0[511] !== 0xaa) return [];
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const off = 446 + i * 16;
    const type = sector0[off + 4];
    const lbaStart = sector0.readUInt32LE(off + 8);
    const sectors = sector0.readUInt32LE(off + 12);
    if (type !== 0 && sectors > 0) {
      parts.push({ index: i + 1, type, lbaStart, sectors });
    }
  }
  return parts;
}

/**
 * 파티션 첫 섹터(FAT 부트섹터)를 보고 진짜 FAT인지 확인하고 볼륨 라벨을 읽는다.
 * FAT12/16 은 라벨이 0x2B, FAT32 는 0x47 에 있다.
 */
function readFatBootSector(sector) {
  if (sector.length < SECTOR) return null;
  if (sector[510] !== 0x55 || sector[511] !== 0xaa) return null;

  const bytesPerSector = sector.readUInt16LE(11);
  if (![512, 1024, 2048, 4096].includes(bytesPerSector)) return null;

  const tag16 = sector.toString('latin1', 54, 62); // "FAT12   " / "FAT16   " / "FAT     "
  const tag32 = sector.toString('latin1', 82, 90); // "FAT32   "
  const isFat32 = tag32.startsWith('FAT32');
  const isFat16 = tag16.startsWith('FAT');
  if (!isFat32 && !isFat16) return null;

  const labelOff = isFat32 ? 71 : 43;
  const label = sector.toString('latin1', labelOff, labelOff + 11).trim();
  return { label, fatType: isFat32 ? 'FAT32' : tag16.trim() || 'FAT' };
}

/** 라벨이 맞는 FAT을 최우선, 없으면 아무 FAT이나. 라벨은 선호일 뿐 필수가 아니다 —
 *  boot 파티션 라벨이 다른 보드(RPi 등)도 이 코드로 같이 처리된다. */
function pickFat(candidates) {
  return candidates.find((c) => (c.label || '').toUpperCase() === CONFIG_PART_LABEL)
      || candidates[0]
      || null;
}

/**
 * 디스크(블록 디바이스 또는 이미지 파일)에서 FAT 파티션들을 찾는다.
 * 반환: [{ index, type, lbaStart, sectors, label, fatType }]
 */
async function findFatPartitions(diskPath) {
  const fh = await fs.promises.open(diskPath, 'r');
  try {
    const mbr = Buffer.alloc(SECTOR);
    await fh.read(mbr, 0, SECTOR, 0);

    const found = [];
    for (const p of parseMbr(mbr)) {
      if (!FAT_PART_TYPES.has(p.type)) continue;
      const boot = Buffer.alloc(SECTOR);
      await fh.read(boot, 0, SECTOR, p.lbaStart * SECTOR);
      const fat = readFatBootSector(boot);
      if (fat) found.push({ ...p, ...fat });
    }
    return found;
  } finally {
    await fh.close();
  }
}

/**
 * `/dev/sdb` + 2 → `/dev/sdb2`, `/dev/mmcblk0` + 2 → `/dev/mmcblk0p2`.
 * 숫자로 끝나는 디바이스는 `p`를 끼워 넣는 게 리눅스 관례다(mmcblk·nvme·loop).
 */
function partitionNodePath(device, index) {
  return /\d$/.test(device) ? `${device}p${index}` : `${device}${index}`;
}

/**
 * 리눅스: dd 직후엔 커널이 옛 파티션 테이블을 들고 있을 수 있어 파티션 노드가 늦게 잡힌다.
 * 노드가 나타날 때까지 잠깐 기다린다.
 * 반환: 파티션 경로(예: /dev/sdb2) 또는 null
 */
async function findFatPartitionLinux(device, { attempts = 10, delayMs = 500 } = {}) {
  const fat = pickFat(await findFatPartitions(device));
  if (!fat) return null;

  const node = partitionNodePath(device, fat.index);
  for (let i = 0; i < attempts; i++) {
    if (fs.existsSync(node)) return node;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return null;
}

/**
 * Windows/macOS: ext4 를 못 읽으므로 OS가 이 디스크에서 마운트해 준 볼륨은 사실상 FAT뿐이다.
 * drivelist 가 주는 마운트 경로를 쓴다 — 드라이브 문자는 매번 달라진다.
 * 반환: 마운트 경로(예: `D:\`, `/Volumes/CLAWLINK`) 또는 null
 */
async function findMountedVolume(drivelist, device, { attempts = 10, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const target = (await drivelist.list()).find((d) => d.device === device);
    const mounts = target?.mountpoints || [];
    if (mounts.length) return (pickFat(mounts) || mounts[0]).path;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return null;
}

const NO_FAT_PARTITION_MSG =
  '설정을 쓸 FAT 파티션을 찾지 못했습니다.\n\n' +
  '이 OS 이미지는 ext4 파티션 하나로만 되어 있어, 이미저가 시리얼·WiFi 설정을 심을 곳이 ' +
  '없습니다. 이대로 두면 보드가 켜져도 활성화되지 않습니다.\n' +
  'OS 이미지에 설정 파티션이 추가돼야 합니다 — clawlink-imager#30 / clawlink#720.';

module.exports = {
  CONFIG_PART_LABEL, FAT_PART_TYPES, NO_FAT_PARTITION_MSG,
  parseMbr, readFatBootSector, pickFat, partitionNodePath,
  findFatPartitions, findFatPartitionLinux, findMountedVolume,
};
