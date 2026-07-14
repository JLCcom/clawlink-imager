// main.js — Electron main process
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');
const { Readable } = require('stream');
const log = require('electron-log');
const drivelist = require('drivelist');
const ghcr = require('./ghcr');
const partition = require('./partition');
const elevate = require('./elevate');

const IS_DEV = process.env.NODE_ENV === 'development' || !app.isPackaged;

// 시리얼 검증용. OS 이미지는 여기서 받지 않는다 — 공개 GHCR OCI 로 옮겼다(#31, 메인 repo #712).
const CLOUD_URL = 'https://clawlinkai.io';

// ── 윈도우 ────────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 560,
    height: 700,
    resizable: false,
    title: 'ClawLink Imager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (IS_DEV) {
    win.loadURL('http://localhost:3000');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../build/index.html'));
  }

  buildMenu(win);
}

// 언어 메뉴(#18) + 도움말>정보(#19). 라디오 체크 표시는 메뉴 자체 상태로만 관리되고
// 렌더러 쪽 localStorage 저장값과는 별도라서, 재시작하면 메뉴 표시는 "시스템 기본"으로
// 돌아간다 — 실제 언어 선택(렌더러가 적용하는 값)은 그대로 유지되니 기능상 문제는 없음.
function buildMenu(win) {
  const template = [
    {
      label: '언어 / Language',
      submenu: [
        { label: '시스템 기본 / System default', type: 'radio', checked: true, click: () => win.webContents.send('set-language', 'system') },
        { label: '한국어', type: 'radio', click: () => win.webContents.send('set-language', 'ko') },
        { label: 'English', type: 'radio', click: () => win.webContents.send('set-language', 'en') },
      ],
    },
    {
      label: '도움말 / Help',
      submenu: [
        {
          label: 'ClawLink Imager 정보 / About ClawLink Imager',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'ClawLink Imager',
              message: `ClawLink Imager v${app.getVersion()}`,
              detail: [
                'Provided by ClawLink — https://clawlinkai.io',
                '',
                'License: Apache License 2.0',
                'https://github.com/JLCcom/clawlink-imager',
              ].join('\n'),
              buttons: ['OK'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── IPC 핸들러 ────────────────────────────────────────────────────────────────

// 시리얼 검증
ipcMain.handle('serial:check', async (_e, serial) => {
  return new Promise((resolve) => {
    const url = `${CLOUD_URL}/api/v1/serials/${encodeURIComponent(serial)}/check`;
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({ valid: false, error: 'parse_error' }); }
      });
    });
    req.on('error', (e) => resolve({ valid: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ valid: false, error: 'timeout' }); });
  });
});

// 보드 이미지 목록 — 공개 GHCR OCI 아티팩트에서 읽는다(#31).
// 옛 `clawlinkai.io/dist/os/manifest.json` 은 폐기됐다(메인 repo #712). 그 URL은 지금
// 404가 아니라 200으로 빈 플레이스홀더를 돌려주기 때문에, 계속 보고 있으면 에러 없이
// 조용히 "굽을 이미지가 없음" 상태가 된다.
ipcMain.handle('os:manifest', async () => {
  try {
    const list = await ghcr.describeAllBoards();
    if (!list.length) return { ok: false, error: 'no boards published', boards: [] };
    const first = list[0];
    return {
      ok: true,
      ref: first.ref,
      osVersion: first.osVersion,
      version: first.version,
      revision: first.revision,
      osBase: first.osBase,
      docker: first.docker,
      updated: first.built,
      boards: list.map((info) => ({
        board: info.board,
        file: info.image.file,
        sha256: info.image.sha256,
        size: info.image.size,
        date: info.built,
        osVersion: info.osVersion,
        version: info.version,
        available: true,
      })),
    };
  } catch (e) {
    log.error('os:manifest error', e);
    return { ok: false, error: e.message, boards: [] };
  }
});

// 이동식 드라이브만 남기는 안전 기준 — sd:burn 쓰기 직전 재검증(#5)에서도 그대로 재사용
function isSafeSdDrive(d) {
  return d.isRemovable && d.size > 1_000_000_000;
}

// 드라이브 목록
ipcMain.handle('drives:list', async () => {
  try {
    const drives = await drivelist.list();
    return drives
      .filter(isSafeSdDrive)
      .map(d => ({ device: d.device, description: d.description, size: d.size, displayName: `${d.description} (${(d.size / 1e9).toFixed(0)} GB) — ${d.device}` }));
  } catch (e) {
    log.error('drives:list error', e);
    return [];
  }
});

// 이미지 준비 (#25) — 다운로드 + sha256 검증까지가 "준비"고, 여기까지만 인터넷이 필요하다.
// 준비가 끝나면 SD 쓰기·설정 주입은 완전히 로컬이라 인터넷을 끊어도 된다.
// 임시 폴더가 아니라 캐시 폴더에 두기 때문에, 같은 이미지로 SD를 여러 장 구울 때
// 다시 받지 않는다.
function imageCacheDir() {
  return path.join(app.getPath('userData'), 'image-cache');
}

ipcMain.handle('image:prepare', async (e, board) => {
  const info = board ? await ghcr.describeBoard(board) : await ghcr.describeLatest();
  const result = await ghcr.prepareImage({
    cacheDir: imageCacheDir(),
    info,
    onProgress: (p) => e.sender.send('prepare:progress', p),
  });
  return { ...result, verified: true, osVersion: info.osVersion, version: info.version };
});

// 오프라인/사전 다운로드분 재사용 (#25). 출처를 모르는 파일이라 sha256 대조 상대가 없다 —
// verified:false 로 돌려주고 UI가 "검증 안 됨"을 드러낸다.
ipcMain.handle('image:pickLocal', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'ClawLink OS 이미지 선택',
    properties: ['openFile'],
    filters: [
      { name: 'ClawLink OS 이미지', extensions: ['xz'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths?.length) return null;
  const p = filePaths[0];
  return { path: p, fileName: path.basename(p), cached: true, verified: false };
});

// clawlink-firstboot.sh(메인 repo)가 clawlink.conf를 `source`로 읽기 때문에,
// 값에 $·`·공백·따옴표가 들어가면 파일이 깨지거나 최악의 경우 root 권한으로
// 임의 shell 명령이 실행될 수 있다(#6). 작은따옴표로 감싸고 내부 작은따옴표만
// 표준 shell escaping('\'')으로 빼내면 어떤 값이 와도 안전하다.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// clawlink.conf 계약 버전 — docs/BOOT_CONTRACT.md §2. 필드를 지우거나 의미를 바꿀 때만 올린다.
const CLAWLINK_CONF_CONTRACT_VERSION = 1;

function buildConf({ serial, wifiSsid, wifiPw, hwModel, sshPassword, sshPubkey }) {
  return [
    `CONTRACT_VERSION=${CLAWLINK_CONF_CONTRACT_VERSION}`,
    `SERIAL=${shellQuote(serial)}`,
    wifiSsid   ? `WIFI_SSID=${shellQuote(wifiSsid)}`     : '',
    wifiPw     ? `WIFI_PW=${shellQuote(wifiPw)}`         : '',
    `HW_MODEL=${shellQuote(hwModel)}`,
    // BYOD(#13) — 비워두면 OS 쪽(clawlink-firstboot.sh, JLCcom/clawlink#617)이
    // 고정 기본값(root/1234, clawlink/1234)으로 fallback.
    sshPassword ? `SSH_PASSWORD=${shellQuote(sshPassword)}` : '',
    sshPubkey   ? `SSH_PUBKEY=${shellQuote(sshPubkey)}`     : '',
  ].filter(Boolean).join('\n') + '\n';
}

// 권한이 필요한 일(dd·mount)을 모아 둔 헬퍼. 패키징되면 resources/ 로 들어간다.
function burnScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'clawlink-burn.sh')
    : path.join(__dirname, '..', 'resources', 'clawlink-burn.sh');
}

// dd 는 진행률을 `\r` 로 덮어쓰며 낸다(`123456 bytes (123 MB, ...) copied`). 한 번에 여러 개가
// 몰려올 수 있으니 마지막 값을 쓴다.
function lastDdBytes(text) {
  const re = /(\d+) bytes/g;
  let match;
  let last = null;
  while ((match = re.exec(text))) last = match[1];
  return last;
}

// 압축 푼 크기를 알아야 진행률을 % 로 낼 수 있다. xz 헤더에 들어 있다.
function uncompressedSize(imagePath) {
  if (!imagePath.endsWith('.xz')) {
    try { return fs.statSync(imagePath).size; } catch { return 0; }
  }
  return new Promise((resolve) => {
    execFile('xz', ['--robot', '-l', imagePath], (err, stdout) => {
      if (err) return resolve(0);
      const totals = stdout.split('\n').find((l) => l.startsWith('totals'));
      resolve(totals ? parseInt(totals.split('\t')[4], 10) || 0 : 0);
    });
  });
}

// Windows 물리 디스크 경로(\\.\PhysicalDriveN)에서 디스크 번호만 뽑아낸다.
function getDiskNumberFromDevice(device) {
  const m = /PhysicalDrive(\d+)/i.exec(device);
  if (!m) throw new Error(`디스크 번호를 device 경로에서 못 찾음: ${device}`);
  return m[1];
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`PowerShell 실패: ${stderr || stdout || err.message}`));
        resolve(stdout);
      }
    );
  });
}

// 쓰기 전 이 디스크의 볼륨(드라이브 문자)을 전부 뗀다 — diskpart 의 `offline disk` 는
// 이동식 미디어(USB SD 리더)에서 "이 작업을 지원하지 않습니다" 로 거부되므로(실기기 확인),
// 대신 파티션 단위로 드라이브 문자만 제거해 탐색기/파일시스템의 점유를 푼다. 안 풀면
// 새 파티션 테이블을 쓰는 도중 Windows 가 디스크 상태 변화를 감지해 핸들을 무효화한다(EBADF).
async function releaseDiskVolumes(diskNum) {
  await runPowerShell(
    `Get-Partition -DiskNumber ${diskNum} | ForEach-Object { ` +
    `if ($_.DriveLetter) { ` +
    `Remove-PartitionAccessPath -DiskNumber ${diskNum} -PartitionNumber $_.PartitionNumber -AccessPath ("$($_.DriveLetter):\\") -ErrorAction SilentlyContinue ` +
    `} }`
  );
}

// 쓰기 후 Windows 가 새 파티션 테이블을 다시 읽게 한다 — 안 하면 findMountedVolume 이
// 새로 생긴 설정 파티션에 드라이브 문자가 잡히는 걸 못 본다.
async function rescanDisks() {
  await runPowerShell('Update-HostStorageCache');
}

// SD 쓰기 + 설정 주입 (#9). 권한 상승은 한 번만 — 두 단계를 따로 승격하면
// 사용자가 암호를 두 번 넣어야 한다.
ipcMain.handle('sd:burn', async (e, opts) => {
  const { imagePath, device } = opts;

  // #5 — renderer가 보내는 device 문자열을 그대로 믿지 않고, 쓰기 직전 다시 한 번
  // 실제 드라이브 목록에서 같은 안전 기준(이동식 · 1GB 이상)으로 재확인한다.
  const freshDrives = await drivelist.list();
  if (!freshDrives.find((d) => d.device === device && isSafeSdDrive(d))) {
    throw new Error('선택한 드라이브를 다시 찾을 수 없습니다. SD카드를 확인하고 목록을 새로고침하세요.');
  }

  // 설정 파티션 번호는 굽기 전에 이미지에서 알아낸다 — dd 가 MBR 을 그대로 복사하므로
  // 이미지의 파티션 번호가 곧 SD카드의 파티션 번호다. 덕분에 권한 상승 전에 끝난다.
  const partIndex = await partition.findFatPartitionIndexForImage(imagePath);
  const progress = (phase, percent) => e.sender.send('burn:progress', { phase, percent });

  if (process.platform === 'win32') {
    // Windows 는 앱 자체가 관리자로 뜬다(package.json requestedExecutionLevel) — 승격 불필요.
    // 7z·dd 가 없으므로 xz 해제를 순수 JS(WASM)로 하고 \\.\PhysicalDriveN 에 직접 쓴다.
    // 'w'(CREATE+TRUNC) 대신 'r+' 로 여는 것은 확인된 수정 — Windows 디바이스 경로는
    // OPEN_EXISTING만 허용해서 'w' 로 열면 EINVAL 이 났다(#8).
    //
    // (실기기 미해결 — #8 2026-07-13 세션 기록) 이 아래 releaseDiskVolumes + 저수준
    // FileHandle.write 조합은 굽기 도중(20~80% 구간)에 나는 EBADF 를 잡으려는 시도지만,
    // 볼륨 드라이브 문자 제거만 했을 때도, 이 저수준 쓰기 방식으로 바꾼 뒤에도 실기기에서
    // 동일하게 재현됐다. 즉 이 코드 자체가 EBADF 를 고친다는 근거는 없다. 세 가지 다른
    // 코드 레벨 접근이 전부 같은 에러를 내는 걸 보면 원인이 Node.js 쓰기 방식이 아니라
    // Windows USB 선택적 절전(Selective Suspend) 같은 전원관리 쪽일 가능성이 높다 —
    // 절전을 끄고 재시험 필요(아직 안 함). 이 블록은 그 재시험 전까지 "미검증"으로 취급할 것.
    const diskNum = getDiskNumberFromDevice(device);
    await releaseDiskVolumes(diskNum);
    try {
      const { XzReadableStream } = require('xz-decompress');
      const total = fs.statSync(imagePath).size; // 압축 파일 크기 기준 — 진행률은 근사치
      let read = 0;
      const compressed = fs.createReadStream(imagePath);
      compressed.on('data', (chunk) => {
        read += chunk.length;
        progress('writing', Math.round((read / total) * 100));
      });
      const decompressed = Readable.fromWeb(new XzReadableStream(Readable.toWeb(compressed)));

      const fd = await fs.promises.open(device, 'r+');
      try {
        let position = 0;
        for await (const chunk of decompressed) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          let off = 0;
          while (off < buf.length) {
            const { bytesWritten } = await fd.write(buf, off, buf.length - off, position + off);
            if (bytesWritten <= 0) throw new Error('디스크 쓰기가 진행되지 않습니다(bytesWritten=0).');
            off += bytesWritten;
          }
          position += buf.length;
        }
      } finally {
        await fd.close();
      }
    } finally {
      // Windows 가 새 파티션 테이블을 다시 읽게 — 안 하면 findMountedVolume 이
      // 새로 생긴 설정 파티션에 드라이브 문자가 잡히는 걸 못 본다.
      // rescanDisks 실패를 던지면 위 쓰기 루프에서 이미 난 진짜 에러(EBADF 등)를
      // finally 가 덮어써서 안 보이게 된다 — 원인 진단 중인 문제라 특히 치명적이라
      // 로그만 남기고 삼킨다.
      try { await rescanDisks(); } catch (err) { log.error('rescanDisks 실패(무시)', err); }
    }

    progress('injecting', 100);
    const mountPath = await partition.findMountedVolume(drivelist, device);
    if (!mountPath) throw new Error(partition.NO_FAT_PARTITION_MSG);
    await fs.promises.writeFile(path.join(mountPath, 'clawlink.conf'), buildConf(opts));
    return true;
  }

  // Linux/macOS — clawlink.conf 를 임시 파일로 넘긴다. WiFi 비번이 들어가므로 0600 으로
  // 만들고 끝나면 지운다. 명령줄 인자로 넘기면 다른 프로세스에 그대로 보인다.
  const confPath = path.join(os.tmpdir(), `clawlink-conf-${Date.now()}`);
  await fs.promises.writeFile(confPath, buildConf(opts), { mode: 0o600 });

  const total = await uncompressedSize(imagePath);
  try {
    await elevate.runElevated(
      process.platform,
      burnScriptPath(),
      [imagePath, device, partIndex ? String(partIndex) : '', confPath],
      (text) => {
        const phase = text.match(/CLPHASE (\w+)/);
        if (phase) return progress(phase[1], phase[1] === 'injecting' ? 100 : 0);
        const bytes = lastDdBytes(text);
        if (bytes && total > 0) progress('writing', Math.min(100, Math.round((bytes / total) * 100)));
      }
    );
  } finally {
    await fs.promises.rm(confPath, { force: true });
  }

  // 이미지는 정상적으로 써졌다 — 다만 설정을 심을 곳이 없었다. 카드는 수동 설치 모드로 쓸 수 있다.
  if (!partIndex) throw new Error(partition.NO_FAT_PARTITION_MSG);
  return true;
});
