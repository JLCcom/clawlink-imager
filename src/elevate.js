// elevate.js — 플랫폼 표준 권한 상승 (#9). 규칙 #1 §3: 임의 우회 금지.
//
// Windows 는 앱 자체가 이미 관리자로 뜬다(package.json 의 requestedExecutionLevel=
// requireAdministrator → 실행 시 UAC). 그래서 여기서 다루는 건 Linux/macOS 뿐이다.
//
//   Linux  — pkexec (polkit). GUI 앱에서 raw sudo 보다 이쪽이 표준이다.
//   macOS  — osascript 의 `do shell script … with administrator privileges`.
const { spawn } = require('child_process');

// 셸에 넘길 인자를 작은따옴표로 감싼다. 안의 작은따옴표만 표준 방식으로 빼낸다.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// AppleScript 문자열 리터럴 — 역슬래시와 큰따옴표만 이스케이프하면 된다.
function appleScriptQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 승격 실행에 쓸 명령을 만든다. 실제로 실행하지는 않는다(테스트하기 쉽게 분리).
 * platform: 'linux' | 'darwin'
 */
function buildElevatedCommand(platform, scriptPath, args) {
  if (platform === 'linux') {
    // pkexec 는 프로그램을 직접 실행한다 — 셸을 거치지 않으니 인용이 필요 없다.
    return { cmd: 'pkexec', args: [scriptPath, ...args], streamsProgress: true };
  }

  if (platform === 'darwin') {
    // osascript 는 명령 전체를 문자열 하나로 받는다 → 셸 인용이 필요하다.
    // `do shell script` 는 명령이 끝난 뒤에야 돌아오므로 진행률을 실시간으로 못 준다.
    const command = [scriptPath, ...args].map(shellQuote).join(' ');
    const script = `do shell script ${appleScriptQuote(command)} with administrator privileges`;
    return { cmd: 'osascript', args: ['-e', script], streamsProgress: false };
  }

  throw new Error(`권한 상승을 지원하지 않는 플랫폼: ${platform}`);
}

// pkexec 는 사용자가 인증창을 취소하면 126, 실행 자체를 못 하면 127 로 끝난다.
function elevationErrorMessage(platform, code, stderr) {
  if (platform === 'linux') {
    if (code === 126) return '관리자 권한 요청이 취소되었습니다.';
    if (code === 127) return 'pkexec 를 찾을 수 없습니다. polkit(pkexec)을 설치해야 SD카드에 쓸 수 있습니다.';
  }
  if (platform === 'darwin' && /User cancelled|-128/.test(stderr)) {
    return '관리자 권한 요청이 취소되었습니다.';
  }
  return stderr.trim() || `권한이 필요한 작업이 실패했습니다 (종료 코드 ${code}).`;
}

/**
 * 스크립트를 승격해서 실행한다.
 * onStderr(line) 로 헬퍼가 stderr 에 흘리는 진행 상황을 그대로 넘긴다.
 */
function runElevated(platform, scriptPath, args, onStderr = () => {}) {
  const { cmd, args: cmdArgs } = buildElevatedCommand(platform, scriptPath, args);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs);
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr(text);
    });

    child.on('error', (e) => reject(new Error(`${cmd} 실행 실패: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(elevationErrorMessage(platform, code, stderr)));
    });
  });
}

module.exports = { buildElevatedCommand, elevationErrorMessage, runElevated, shellQuote, appleScriptQuote };
