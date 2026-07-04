import { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';

const BOARDS = [
  { key: 'rpi3',     label: 'Raspberry Pi 3B/3B+' },
  { key: 'rpi4',     label: 'Raspberry Pi 4B' },
  { key: 'rpi5',     label: 'Raspberry Pi 5' },
  { key: 'opizero3', label: 'Orange Pi Zero3' },
  { key: 'opizero2w',label: 'Orange Pi Zero 2W' },
];

const CLOUD_URL = 'https://clawlinkai.io';

export default function App() {
  const [serial, setSerial]         = useState('');
  const [serialStatus, setSerialStatus] = useState(null); // null | 'checking' | { valid, sku, status }
  const [boards, setBoards]         = useState(BOARDS);
  const [board, setBoard]           = useState('rpi4');
  const [wifiSsid, setWifiSsid]     = useState('');
  const [wifiPw, setWifiPw]         = useState('');
  const [drives, setDrives]         = useState([]);
  const [drive, setDrive]           = useState('');
  const [phase, setPhase]           = useState('idle'); // idle | downloading | writing | injecting | done | error
  const [progress, setProgress]     = useState(0);
  const [errorMsg, setErrorMsg]     = useState('');
  const debounceRef = useRef(null);

  // 보드 이미지 목록 로드
  useEffect(() => {
    window.clImager?.getOsManifest().then((m) => {
      if (m?.boards?.length) setBoards(m.boards.map(b => ({ key: b.board, label: BOARDS.find(x => x.key === b.board)?.label || b.board, available: b.available !== false, file: b.file, sha256: b.sha256 })));
    });
    window.clImager?.listDrives().then(setDrives);
    window.clImager?.onDownloadProgress(v => setProgress(v));
    window.clImager?.onWriteProgress(() => {});
  }, []);

  // 시리얼 실시간 검증 (debounce 500ms)
  const handleSerialChange = useCallback((v) => {
    setSerial(v);
    setSerialStatus(null);
    clearTimeout(debounceRef.current);
    if (v.length < 8) return;
    setSerialStatus('checking');
    debounceRef.current = setTimeout(async () => {
      const r = await window.clImager?.checkSerial(v);
      setSerialStatus(r || { valid: false, error: 'no_response' });
    }, 500);
  }, []);

  const refreshDrives = () => window.clImager?.listDrives().then(setDrives);

  const handleBurn = async () => {
    if (!serialStatus?.valid) return;
    if (!drive) return;
    const selectedBoard = boards.find(b => b.key === board);
    if (!selectedBoard) return;

    setPhase('downloading');
    setProgress(0);
    setErrorMsg('');

    try {
      const imageUrl = `${CLOUD_URL}/dist/os/${selectedBoard.file}`;
      const tmpPath = await window.clImager.downloadImage({ url: imageUrl, fileName: selectedBoard.file });

      setPhase('writing');
      setProgress(0);
      await window.clImager.writeSD({ imagePath: tmpPath, device: drive });

      setPhase('injecting');
      await window.clImager.injectBoot({ device: drive, serial, wifiSsid, wifiPw, hwModel: board });

      setPhase('done');
    } catch (e) {
      setErrorMsg(e?.message || String(e));
      setPhase('error');
    }
  };

  const canBurn = serialStatus?.valid && drive && phase === 'idle';
  const phaseLabel = { idle: '', downloading: '다운로드 중', writing: 'SD 쓰기 중', injecting: '설정 주입 중', done: '완료!', error: '오류' }[phase] || '';

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">⬡</span>
        <span className="title">ClawLink Imager</span>
      </header>

      <main>
        {/* 시리얼 */}
        <section className="field">
          <label>시리얼 번호</label>
          <div className="input-row">
            <input
              value={serial}
              onChange={e => handleSerialChange(e.target.value)}
              placeholder="CL-EO1-YYMMDD-000001"
              className="input-serial"
            />
            {serialStatus === 'checking' && <span className="badge checking">확인 중…</span>}
            {serialStatus?.valid  === true  && <span className="badge ok">✅ 유효</span>}
            {serialStatus?.valid  === false && <span className="badge err">❌ 오류</span>}
          </div>
          {serialStatus?.valid && <p className="hint">유형: {serialStatus.sku} · 상태: {serialStatus.status}</p>}
          {serialStatus?.valid === false && <p className="hint err">시리얼을 확인하세요.</p>}
        </section>

        {/* 보드 선택 */}
        <section className="field">
          <label>보드</label>
          <select value={board} onChange={e => setBoard(e.target.value)}>
            {boards.map(b => <option key={b.key} value={b.key}>{b.label}{b.available === false ? ' (준비 중)' : ''}</option>)}
          </select>
        </section>

        {/* WiFi */}
        <section className="field">
          <label>WiFi 설정 <span className="opt">(선택)</span></label>
          <input value={wifiSsid} onChange={e => setWifiSsid(e.target.value)} placeholder="SSID" className="mb4" />
          <input value={wifiPw} onChange={e => setWifiPw(e.target.value)} placeholder="비밀번호" type="password" />
        </section>

        {/* SD 카드 */}
        <section className="field">
          <label>SD 카드 <button className="refresh-btn" onClick={refreshDrives}>↻</button></label>
          {drives.length === 0
            ? <p className="hint">SD 카드를 꽂고 ↻ 버튼을 누르세요.</p>
            : <select value={drive} onChange={e => setDrive(e.target.value)}>
                <option value="">— 드라이브 선택 —</option>
                {drives.map(d => <option key={d.device} value={d.device}>{d.displayName}</option>)}
              </select>}
        </section>

        {/* 진행률 */}
        {phase !== 'idle' && phase !== 'done' && phase !== 'error' && (
          <div className="progress-wrap">
            <div className="progress-label">{phaseLabel}</div>
            <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
            <div className="progress-pct">{progress}%</div>
          </div>
        )}

        {phase === 'done' && (
          <div className="done-msg">
            ✅ 완료! SD 카드를 보드에 꽂고 전원을 켜세요.<br />
            첫 부팅 시 자동으로 ClawLink 엣지가 설치됩니다.
          </div>
        )}

        {phase === 'error' && <div className="error-msg">⚠️ {errorMsg}</div>}

        {/* 굽기 버튼 */}
        <button
          className={`burn-btn ${canBurn ? 'active' : ''}`}
          disabled={!canBurn}
          onClick={handleBurn}
        >
          {phase === 'idle' ? '굽기 시작' : phaseLabel}
        </button>
      </main>
    </div>
  );
}
