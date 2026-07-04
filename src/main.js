// main.js — Electron main process
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');
const https = require('https');
const http = require('http');
const log = require('electron-log');

const IS_DEV = process.env.NODE_ENV === 'development' || !app.isPackaged;
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

// 보드 이미지 목록
ipcMain.handle('os:manifest', async () => {
  return new Promise((resolve) => {
    const url = `${CLOUD_URL}/dist/os/manifest.json`;
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({ boards: [] }); }
      });
    });
    req.on('error', () => resolve({ boards: [] }));
  });
});

// 드라이브 목록
ipcMain.handle('drives:list', async () => {
  try {
    const drivelist = require('drivelist');
    const drives = await drivelist.list();
    return drives
      .filter(d => d.isRemovable && d.size > 1_000_000_000)
      .map(d => ({ device: d.device, description: d.description, size: d.size, displayName: `${d.description} (${(d.size / 1e9).toFixed(0)} GB) — ${d.device}` }));
  } catch (e) {
    log.error('drives:list error', e);
    return [];
  }
});

// 이미지 다운로드
ipcMain.handle('image:download', async (e, { url, destPath, fileName }) => {
  const tmpFile = path.join(app.getPath('temp'), fileName);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmpFile);
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      const total = parseInt(res.headers['content-length'] || '0');
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) e.sender.send('download:progress', Math.round((received / total) * 100));
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(tmpFile); });
      file.on('error', reject);
    });
    req.on('error', reject);
  });
});

// SD 쓰기
ipcMain.handle('sd:write', async (e, { imagePath, device }) => {
  return new Promise((resolve, reject) => {
    // xz 압축 해제 후 dd 쓰기
    const cmd = process.platform === 'win32'
      ? `7z x -so "${imagePath}" | dd of="${device}" bs=4M`
      : `xzcat "${imagePath}" | dd of="${device}" bs=4M status=progress`;

    const child = exec(cmd, { shell: '/bin/bash' }, (err) => {
      if (err) reject(err); else resolve(true);
    });

    child.stderr?.on('data', (d) => {
      const m = d.toString().match(/(\d+) bytes/);
      if (m) e.sender.send('write:progress', parseInt(m[1]));
    });
  });
});

// boot 파티션 마운트 + clawlink.conf 주입
ipcMain.handle('boot:inject', async (_e, { device, serial, wifiSsid, wifiPw, hwModel }) => {
  return new Promise((resolve, reject) => {
    const bootPart = process.platform === 'win32' ? device : `${device}1`;
    const mountDir = `/tmp/clawlink-boot-${Date.now()}`;

    const confContent = [
      `SERIAL=${serial}`,
      wifiSsid ? `WIFI_SSID=${wifiSsid}` : '',
      wifiPw   ? `WIFI_PW=${wifiPw}`     : '',
      `HW_MODEL=${hwModel}`,
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
    } else {
      // Windows/Mac: 볼륨이 자동 마운트되므로 직접 파일 쓰기 시도
      const bootRoot = process.platform === 'darwin' ? `/Volumes/boot` : `D:\\`;
      fs.writeFile(path.join(bootRoot, 'clawlink.conf'), confContent, (e2) => {
        if (e2) reject(new Error(`boot 파티션 쓰기 실패: ${e2.message}`)); else resolve(true);
      });
    }
  });
});
