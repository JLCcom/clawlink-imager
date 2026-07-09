// main.js — Electron main process
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');
const https = require('https');
const http = require('http');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const log = require('electron-log');
const drivelist = require('drivelist');
const ghcr = require('./ghcr');

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
    const info = await ghcr.describeLatest();
    return {
      ok: true,
      ref: info.ref,
      osVersion: info.osVersion,
      version: info.version,
      revision: info.revision,
      osBase: info.osBase,
      docker: info.docker,
      updated: info.built,
      boards: [{
        board: info.board,
        file: info.image.file,
        sha256: info.image.sha256,
        size: info.image.size,
        date: info.built,
        available: true,
      }],
    };
  } catch (e) {
    log.error('os:manifest error', e);
    return { ok: false, error: e.message, boards: [] };
  }
});

// 이동식 드라이브만 남기는 안전 기준 — sd:write 쓰기 직전 재검증(#5)에서도 그대로 재사용
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

ipcMain.handle('image:prepare', async (e) => {
  const info = await ghcr.describeLatest();
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

// SD 쓰기
ipcMain.handle('sd:write', async (e, { imagePath, device }) => {
  // #5 — renderer가 보내는 device 문자열을 그대로 믿지 않고, 쓰기 직전 다시 한 번
  // 실제 드라이브 목록에서 같은 안전 기준(이동식 · 1GB 이상)으로 재확인한다.
  // (드라이브가 그 사이 빠졌거나, 다른 드라이브로 교체됐을 수 있음)
  const freshDrives = await drivelist.list();
  const match = freshDrives.find(d => d.device === device && isSafeSdDrive(d));
  if (!match) {
    throw new Error('선택한 드라이브를 다시 찾을 수 없습니다. SD카드를 확인하고 목록을 새로고침하세요.');
  }

  if (process.platform === 'win32') {
    // (실기기 미검증 — #8) Windows에는 7z·dd가 기본으로 없어서 예전 코드가 그냥 실패했다.
    // 외부 바이너리를 번들링하는 대신, xz 해제를 순수 JS(WASM, xz-decompress)로 하고
    // drivelist가 주는 원본 디바이스 경로(\\.\PhysicalDriveN)에 Node fs로 직접 쓴다 —
    // Etcher·RPi Imager와 같은 원리(관리자 권한 필요 — package.json의
    // win.requestedExecutionLevel=requireAdministrator로 앱 실행 시 UAC 요청, #9).
    const { XzReadableStream } = require('xz-decompress');
    const total = fs.statSync(imagePath).size; // 압축 파일 크기 기준 — 진행률은 근사치
    let compressedRead = 0;
    const compressedStream = fs.createReadStream(imagePath);
    compressedStream.on('data', (chunk) => {
      compressedRead += chunk.length;
      e.sender.send('write:progress', Math.round((compressedRead / total) * 100));
    });
    const decompressed = Readable.fromWeb(new XzReadableStream(Readable.toWeb(compressedStream)));
    const out = fs.createWriteStream(device, { flags: 'w' });
    await pipeline(decompressed, out);
    return true;
  }

  // Linux/Mac: xzcat | dd (실기기 검증 별도 — #11)
  return new Promise((resolve, reject) => {
    const cmd = `xzcat "${imagePath}" | dd of="${device}" bs=4M status=progress`;
    const child = exec(cmd, (err) => {
      if (err) reject(err); else resolve(true);
    });
    child.stderr?.on('data', (d) => {
      const m = d.toString().match(/(\d+) bytes/);
      if (m) e.sender.send('write:progress', parseInt(m[1]));
    });
  });
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

// boot 파티션 마운트 + clawlink.conf 주입
ipcMain.handle('boot:inject', async (_e, { device, serial, wifiSsid, wifiPw, hwModel, sshPassword, sshPubkey }) => {
  return new Promise((resolve, reject) => {
    const bootPart = process.platform === 'win32' ? device : `${device}1`;
    const mountDir = `/tmp/clawlink-boot-${Date.now()}`;

    const confContent = [
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

    if (process.platform === 'linux') {
      exec(`mkdir -p ${mountDir} && mount ${bootPart} ${mountDir}`, (err) => {
        if (err) return reject(err);
        fs.writeFile(`${mountDir}/clawlink.conf`, confContent, (e2) => {
          exec(`umount ${mountDir} && rmdir ${mountDir}`, () => {
            if (e2) reject(e2); else resolve(true);
          });
        });
      });
    } else if (process.platform === 'win32') {
      // (실기기 미검증 — #8/#9) 드라이브 문자는 매번 달라질 수 있어 고정값(D:\)을
      // 쓰면 틀리기 쉽다 — drivelist로 이 물리 디스크가 실제로 마운트된 경로를
      // 찾는다. Windows는 rootfs(ext4) 파티션은 못 읽으므로 보통 boot(FAT32)
      // 파티션 하나만 드라이브 문자가 잡힌다.
      drivelist.list().then((drives) => {
        const target = drives.find((d) => d.device === device);
        const mountPath = target?.mountpoints?.[0]?.path;
        if (!mountPath) {
          return reject(new Error('boot 파티션의 드라이브 문자를 찾지 못했습니다. SD카드를 다시 꽂고 새로고침 후 시도하세요.'));
        }
        fs.writeFile(path.join(mountPath, 'clawlink.conf'), confContent, (e2) => {
          if (e2) reject(new Error(`boot 파티션 쓰기 실패: ${e2.message}`)); else resolve(true);
        });
      }, reject);
    } else {
      // macOS: 볼륨이 자동 마운트되므로 직접 파일 쓰기 시도 (실기기 미검증)
      const bootRoot = `/Volumes/boot`;
      fs.writeFile(path.join(bootRoot, 'clawlink.conf'), confContent, (e2) => {
        if (e2) reject(new Error(`boot 파티션 쓰기 실패: ${e2.message}`)); else resolve(true);
      });
    }
  });
});
