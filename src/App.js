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

// 입력 필드 기억 — 매번 앱을 다시 설치/실행할 때마다 시리얼·WiFi·SSH를 새로 치는 게
// 너무 불편하다는 실사용 피드백으로 추가. 로컬(이 PC)에만 저장되고 어디로도 전송되지 않는다.
const SAVED_FIELDS_KEY = 'cl-imager-fields';
function loadSavedFields() {
  try { return JSON.parse(window.localStorage?.getItem(SAVED_FIELDS_KEY) || '{}'); } catch { return {}; }
}

export default function App() {
  const [serial, setSerial]         = useState(() => loadSavedFields().serial || '');
  const [serialStatus, setSerialStatus] = useState(null); // null | 'checking' | { valid, sku, status }
  const [boards, setBoards]         = useState(() => BOARDS.map(b => ({ ...b, available: false })));
  const [board, setBoard]           = useState(() => loadSavedFields().board || 'opizero3');
  const [osInfo, setOsInfo]         = useState(null);   // os:manifest 응답
  const [manifestErr, setManifestErr] = useState('');
  const [image, setImage]           = useState(null);   // 준비된 이미지 { path, fileName, verified, cached }
  const [wifiSsid, setWifiSsid]     = useState(() => loadSavedFields().wifiSsid || '');
  const [wifiPw, setWifiPw]         = useState(() => loadSavedFields().wifiPw || '');
  const [sshPassword, setSshPassword] = useState(() => loadSavedFields().sshPassword || '');
  const [sshPubkey, setSshPubkey]     = useState(() => loadSavedFields().sshPubkey || '');
  const [drives, setDrives]         = useState([]);
  const [drive, setDrive]           = useState('');
  // 준비(idle→preparing→ready)와 굽기(writing→injecting→done)를 분리한다(#25).
  const [phase, setPhase]           = useState('idle');
  const [stage, setStage]           = useState('downloading'); // preparing 중 세부 단계
  const [progress, setProgress]     = useState(0);
  const [errorMsg, setErrorMsg]     = useState('');
  const [langPref, setLangPref]     = useState(() => window.localStorage?.getItem('cl-lang') || 'system');
  const debounceRef = useRef(null);

  const lang = resolveLang(langPref === 'system' ? null : langPref);
  const t = getDict(lang);

  useEffect(() => {
    window.clImager?.getOsManifest().then((m) => {
      if (!m?.ok) { setManifestErr(m?.error || 'unknown'); return; }
      setOsInfo(m);
      const published = new Set((m.boards || []).map(b => b.board));
      setBoards(BOARDS.map(b => ({
        ...b,
        available: published.has(b.key),
        ...(m.boards.find(x => x.board === b.key) || {}),
      })));
      // board 키 자체가 알 수 없는 값일 때만 옮긴다 — "발행 안 됨"은 로컬 파일 선택으로
      // 여전히 구울 수 있으므로, 기억해둔 선택(예: rpi5)을 매번 덮어쓰지 않는다.
      const first = (m.boards || [])[0];
      if (first && !BOARDS.some(b => b.key === board)) setBoard(first.board);
    });
    window.clImager?.listDrives().then(setDrives);
    window.clImager?.onPrepareProgress(({ stage: s, percent }) => { setStage(s); setProgress(percent); });
    // 굽기는 main 이 단계(writing/injecting)와 진행률을 같이 보낸다 — 권한 상승이 한 번뿐이라
    // 두 단계가 한 호출 안에서 이어진다.
    window.clImager?.onBurnProgress(({ phase: p, percent }) => { setPhase(p); setProgress(percent); });
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

  // 입력값 기억 — 바뀔 때마다 로컬에 저장(다음 실행 때 자동으로 채워짐).
  useEffect(() => {
    window.localStorage?.setItem(SAVED_FIELDS_KEY, JSON.stringify({
      serial, board, wifiSsid, wifiPw, sshPassword, sshPubkey,
    }));
  }, [serial, board, wifiSsid, wifiPw, sshPassword, sshPubkey]);

  const handleResetFields = () => {
    window.localStorage?.removeItem(SAVED_FIELDS_KEY);
    setSerial('');
    setSerialStatus(null);
    setBoard('opizero3');
    setWifiSsid('');
    setWifiPw('');
    setSshPassword('');
    setSshPubkey('');
  };

  const refreshDrives = () => window.clImager?.listDrives().then(setDrives);

  const selectedBoard = boards.find(b => b.key === board);

  // 1단계 — 준비(인터넷 필요). 다운로드 + sha256 검증까지.
  const handlePrepare = async () => {
    setPhase('preparing');
    setProgress(0);
    setStage('downloading');
    setErrorMsg('');
    try {
      setImage(await window.clImager.prepareImage(board));
      setPhase('ready');
    } catch (e) {
      setErrorMsg(e?.message || String(e));
      setPhase('error');
    }
  };

  const handlePickLocal = async () => {
    const picked = await window.clImager?.pickLocalImage();
    if (!picked) return;
    setErrorMsg('');
    setImage(picked);
    setPhase('ready');
  };

  // 2단계 — 굽기(완전 로컬). 인터넷이 끊겨 있어도 된다.
  // 리눅스/맥은 여기서 한 번 권한 상승 프롬프트가 뜬다(#9).
  const handleBurn = async () => {
    if (!canBurn) return;
    setErrorMsg('');
    try {
      setPhase('writing');
      setProgress(0);
      await window.clImager.burnSD({
        imagePath: image.path, device: drive,
        serial, wifiSsid, wifiPw, hwModel: board, sshPassword, sshPubkey,
      });
      setPhase('done');
    } catch (e) {
      setErrorMsg(e?.message || String(e));
      // 이미지는 이미 준비돼 있다 — 굽기만 다시 누를 수 있게 'ready'로 되돌린다.
      setPhase('ready');
    }
  };

  const canPrepare = selectedBoard?.available && (phase === 'idle' || phase === 'error');
  const canBurn    = !!image && !!drive && serialStatus?.valid === true && phase === 'ready';
  const busy       = phase === 'preparing' || phase === 'writing' || phase === 'injecting';
  const phaseLabel = t.phase[phase] || '';
  const progressLabel = phase === 'preparing' ? t.stage[stage] : phaseLabel;

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">⬡</span>
        <span className="title">ClawLink Imager</span>
        <button className="reset-btn" onClick={handleResetFields} disabled={busy} title={t.resetFieldsHint}>
          {t.resetFieldsBtn}
        </button>
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
          <select value={board} onChange={e => setBoard(e.target.value)} disabled={busy}>
            {boards.map(b => <option key={b.key} value={b.key}>{b.label}{b.available === false ? t.boardPreparing : ''}</option>)}
          </select>
          {selectedBoard && !selectedBoard.available && !manifestErr && <p className="hint">{t.boardUnavailable}</p>}
        </section>

        {/* 1단계 — 이미지 준비 (여기까지만 인터넷 필요) */}
        <section className="field">
          <label>{t.imageLabel}</label>
          {manifestErr && <p className="hint err">{t.manifestError}</p>}

          {image ? (
            <p className="hint">
              {t.imageReady(image.fileName)}<br />
              {image.verified ? t.imageVerified : t.imageUnverified}
              {image.cached && image.verified ? ` ${t.imageCached}` : ''}
              {image.osVersion && image.verified ? ` · ${t.imageVersion(image.osVersion)}` : ''}
            </p>
          ) : (
            <>
              <p className="hint">{t.imageNotPrepared}</p>
              <p className="hint">{t.imageOfflineHint}</p>
            </>
          )}

          <div className="input-row">
            <button onClick={handlePrepare} disabled={!canPrepare || busy}>
              {image ? t.imagePrepareRetry : t.imagePrepareBtn}
            </button>
            <button onClick={handlePickLocal} disabled={busy}>{t.imageLocalBtn}</button>
          </div>
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
            : <select value={drive} onChange={e => setDrive(e.target.value)} disabled={busy}>
                <option value="">{t.sdSelect}</option>
                {drives.map(d => <option key={d.device} value={d.device}>{d.displayName}</option>)}
              </select>}
        </section>

        {/* 진행률 */}
        {busy && (
          <div className="progress-wrap">
            <div className="progress-label">{progressLabel}</div>
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

        {errorMsg && !busy && <div className="error-msg">⚠️ {errorMsg}</div>}

        {/* 2단계 — 굽기 (완전 로컬) */}
        {phase === 'done' ? (
          <button className="burn-btn active" onClick={() => { setPhase('ready'); setProgress(0); }}>
            {t.burnAgain}
          </button>
        ) : (
          <button
            className={`burn-btn ${canBurn ? 'active' : ''}`}
            disabled={!canBurn}
            onClick={handleBurn}
          >
            {busy ? progressLabel : t.burnStart}
          </button>
        )}
        {!image && phase !== 'done' && <p className="hint">{t.needPrepareHint}</p>}
      </main>
    </div>
  );
}
