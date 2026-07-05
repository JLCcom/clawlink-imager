// i18n.js — 최소 번역 사전. ko/en만 지원 (#18).
export const LANGS = ['ko', 'en'];

const dict = {
  ko: {
    serialLabel: '시리얼 번호',
    serialPlaceholder: 'CL-EO1-YYMMDD-000001',
    checking: '확인 중…',
    valid: '✅ 유효',
    invalid: '❌ 오류',
    serialHint: (sku, status) => `유형: ${sku} · 상태: ${status}`,
    serialInvalidHint: '시리얼을 확인하세요.',
    boardLabel: '보드',
    boardPreparing: ' (준비 중)',
    wifiLabel: 'WiFi 설정',
    optional: '(선택)',
    wifiSsidPlaceholder: 'SSID',
    wifiPwPlaceholder: '비밀번호',
    sshLabel: 'SSH 접속',
    sshOptional: '(선택 — 비우면 기본 계정 사용)',
    sshHint: '기본 계정: root/1234, clawlink/1234 — 아래에 입력하면 그 값으로 바뀝니다.',
    sshPasswordPlaceholder: '내 비밀번호로 바꾸기',
    sshPubkeyPlaceholder: '공개키로 접속하려면 여기에 붙여넣기 (ssh-ed25519 AAAA...)',
    sdLabel: 'SD 카드',
    sdHint: 'SD 카드를 꽂고 ↻ 버튼을 누르세요.',
    sdSelect: '— 드라이브 선택 —',
    phase: { idle: '', downloading: '다운로드 중', writing: 'SD 쓰기 중', injecting: '설정 주입 중', done: '완료!', error: '오류' },
    doneMsg1: '✅ 완료! SD 카드를 보드에 꽂고 전원을 켜세요.',
    doneMsg2: '첫 부팅 시 자동으로 ClawLink 엣지가 설치됩니다.',
    burnStart: '굽기 시작',
  },
  en: {
    serialLabel: 'Serial number',
    serialPlaceholder: 'CL-EO1-YYMMDD-000001',
    checking: 'Checking…',
    valid: '✅ Valid',
    invalid: '❌ Invalid',
    serialHint: (sku, status) => `Type: ${sku} · Status: ${status}`,
    serialInvalidHint: 'Check the serial number.',
    boardLabel: 'Board',
    boardPreparing: ' (coming soon)',
    wifiLabel: 'WiFi settings',
    optional: '(optional)',
    wifiSsidPlaceholder: 'SSID',
    wifiPwPlaceholder: 'Password',
    sshLabel: 'SSH access',
    sshOptional: '(optional — uses the default account if left empty)',
    sshHint: 'Default account: root/1234, clawlink/1234 — filling this in changes it.',
    sshPasswordPlaceholder: 'Set your own password',
    sshPubkeyPlaceholder: 'Paste a public key to use key-based login (ssh-ed25519 AAAA...)',
    sdLabel: 'SD card',
    sdHint: 'Insert an SD card, then press ↻.',
    sdSelect: '— Select a drive —',
    phase: { idle: '', downloading: 'Downloading', writing: 'Writing to SD card', injecting: 'Applying settings', done: 'Done!', error: 'Error' },
    doneMsg1: '✅ Done! Plug the SD card into the board and power it on.',
    doneMsg2: 'ClawLink edge installs itself automatically on first boot.',
    burnStart: 'Start burning',
  },
};

// pref: 저장된 값('ko'|'en') 또는 'system'/null(자동 감지)
export function resolveLang(pref) {
  if (pref && LANGS.includes(pref)) return pref;
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'en') || 'en';
  const short = nav.slice(0, 2).toLowerCase();
  return LANGS.includes(short) ? short : 'en';
}

export function getDict(lang) {
  return dict[lang] || dict.en;
}
