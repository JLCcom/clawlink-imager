import { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';
import { resolveLang, getDict } from './i18n';

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
  const [sshPassword, setSshPassword] = useState('');
  const [sshPubkey, setSshPubkey]     = useState('');
  const [drives, setDrives]         = useState([]);
  const [drive, setDrive]           = useState('');
  const [phase, setPhase]           = useState('idle'); // idle | downloading | writing | injecting | done | error
  const [progress, setProgress]     = useState(0);
  const [errorMsg, setErrorMsg]     = useState('');
  const [langPref, setLangPref]     = useState(() => window.localStorage?.getItem('cl-lang') || 'system');
  const debounceRef = useRef(null);

  const lang = resolveLang(langPref === 'system' ? null : langPref);
  const t = getDict(lang);

  // 보드 이미지 목록 로드
  useEffect(() => {
    window.clImager?.getOsManifest().then((m) => {
      if (m?.boards?.length) setBoards(m.boards.map(b => ({ key: b.board, label: BOARDS.find(x => x.key === b.board)?.label || b.board, available: b.available !== false, file: b.file, sha256: b.sha256 })));
    });
    window.clImager?.listDrives().then(setDrives);
    window.clImager?.onDownloadProgress(v => setProgress(v));
    window.clImager?.onWriteProgress(() => {});
    // 메뉴의 언어 선택(#18) — 'system'이면 OS/브라우저 로케일로 자동 감지.
    window.clImager?.onSetLanguage((code) => {
      setLangPref(code);
      window.localStorage?.setItem('cl-lang', code);
    });
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
      await window.clImager.injectBoot({ device: drive, serial, wifiSsid, wifiPw, hwModel: board, sshPassword, sshPubkey });

      setPhase('done');
    } catch (e) {
      setErrorMsg(e?.message || String(e));
      setPhase('error');
    }
  };

  const canBurn = serialStatus?.valid && drive && phase === 'idle';
  const phaseLabel = t.phase[phase] || '';

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">⬡</span>
        <span className="title">ClawLink Imager</span>
      </header>

      <main>
        {/* 시리얼 */}
        <section className="field">
          <label>{t.serialLabel}</label>
          <div className="input-row">
            <input
              value={serial}
              onChange={e => handleSerialChange(e.target.value)}
              placeholder={t.serialPlaceholder}
              className="input-serial"
            />
            {serialStatus === 'checking' && <span className="badge checking">{t.checking}</span>}
            {serialStatus?.valid  === true  && <span className="badge ok">{t.valid}</span>}
            {serialStatus?.valid  === false && <span className="badge err">{t.invalid}</span>}
          </div>
          {serialStatus?.valid && <p className="hint">{t.serialHint(serialStatus.sku, serialStatus.status)}</p>}
          {serialStatus?.valid === false && <p className="hint err">{t.serialInvalidHint}</p>}
        </section>

        {/* 보드 선택 */}
        <section className="field">
          <label>{t.boardLabel}</label>
          <select value={board} onChange={e => setBoard(e.target.value)}>
            {boards.map(b => <option key={b.key} value={b.key}>{b.label}{b.available === false ? t.boardPreparing : ''}</option>)}
          </select>
        </section>

        {/* WiFi */}
        <section className="field">
          <label>{t.wifiLabel} <span className="opt">{t.optional}</span></label>
          <input value={wifiSsid} onChange={e => setWifiSsid(e.target.value)} placeholder={t.wifiSsidPlaceholder} className="mb4" />
          <input value={wifiPw} onChange={e => setWifiPw(e.target.value)} placeholder={t.wifiPwPlaceholder} type="password" />
        </section>

        {/* SSH — BYOD: 비워두면 기본값(root/1234, clawlink/1234) 그대로 사용 */}
        <section className="field">
          <label>{t.sshLabel} <span className="opt">{t.sshOptional}</span></label>
          <p className="hint">{t.sshHint}</p>
          <input value={sshPassword} onChange={e => setSshPassword(e.target.value)} placeholder={t.sshPasswordPlaceholder} type="password" className="mb4" />
          <textarea
            value={sshPubkey}
            onChange={e => setSshPubkey(e.target.value)}
            placeholder={t.sshPubkeyPlaceholder}
            className="input-pubkey"
            rows={2}
          />
        </section>

        {/* SD 카드 */}
        <section className="field">
          <label>{t.sdLabel} <button className="refresh-btn" onClick={refreshDrives}>↻</button></label>
          {drives.length === 0
            ? <p className="hint">{t.sdHint}</p>
            : <select value={drive} onChange={e => setDrive(e.target.value)}>
                <option value="">{t.sdSelect}</option>
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
            {t.doneMsg1}<br />
            {t.doneMsg2}
          </div>
        )}

        {phase === 'error' && <div className="error-msg">⚠️ {errorMsg}</div>}

        {/* 굽기 버튼 */}
        <button
          className={`burn-btn ${canBurn ? 'active' : ''}`}
          disabled={!canBurn}
          onClick={handleBurn}
        >
          {phase === 'idle' ? t.burnStart : phaseLabel}
        </button>
      </main>
    </div>
  );
}
