// ghcr.js — GHCR(OCI 아티팩트)에서 ClawLink OS 이미지를 익명으로 받아온다 (#31).
//
// 배포 채널이 클라우드 `/dist/os` HTTP 에서 공개 GHCR OCI 로 바뀌었다(메인 repo #712).
// oras 바이너리를 3개 플랫폼에 번들하지 않고 순수 https 로 처리한다 — GHCR 블롭 주소가
// 곧 그 파일의 sha256 이라, 받으면서 해시를 계산하면 그게 무결성 검증이 된다
// (동봉된 `.sha256` 파일 내용도 이 digest 와 같은 값이다).
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const REGISTRY = 'ghcr.io';
const REPO = 'jlccom/clawlink-edge-os';
const TAG = 'latest';

// 멀티보드(#788) — 보드별로 별도 태그(`<board>-latest`)에 게시된다. opizero3(EO1)는
// 구버전 imager 호환을 위해 태그 없는 `latest` 도 계속 유지(release-edge-os-image.sh 가 이중 push).
//   그래서 opizero3 만 `<board>-latest` 조회 실패 시 구태그로 폴백한다.
const KNOWN_BOARDS = ['opizero3', 'opizero2w', 'rpi3', 'rpi4', 'rpi5'];
const LEGACY_TAG_BOARD = 'opizero3';

const MANIFEST_ACCEPT = 'application/vnd.oci.image.manifest.v1+json';
const TITLE_ANNOTATION = 'org.opencontainers.image.title';

const NET_TIMEOUT_MS = 30_000;

// ── https ────────────────────────────────────────────────────────────────────

// GHCR 블롭은 307로 pkg-containers.githubusercontent.com 의 서명 URL로 넘어간다.
// 그 서명 URL에 Authorization 헤더를 같이 보내면 안 된다 — 이미 URL 자체에 권한이
// 실려 있고, 남의 호스트로 토큰을 흘리는 셈이 된다. 호스트가 바뀌면 헤더를 턴다.
function httpsGet(url, headers = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.get(target, { headers, timeout: NET_TIMEOUT_MS }, (res) => {
      const status = res.statusCode;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // 소켓 반환
        if (redirectsLeft <= 0) return reject(new Error('리다이렉트가 너무 많습니다.'));
        const next = new URL(res.headers.location, url);
        const nextHeaders = next.host === target.host
          ? headers
          : Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization'));
        return resolve(httpsGet(next.toString(), nextHeaders, redirectsLeft - 1));
      }

      if (status !== 200) {
        res.resume();
        return reject(new Error(`GHCR 응답 ${status} — ${target.pathname}`));
      }
      resolve(res);
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('GHCR 연결 시간 초과')));
  });
}

async function readAll(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ── 토큰 ─────────────────────────────────────────────────────────────────────

// public repo 라도 토큰은 필요하다(토큰 없이 호출하면 401). 로그인은 필요 없다.
let cachedToken = null; // { token, expiresAt }

async function getAnonymousToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const url = `https://${REGISTRY}/token?scope=repository:${REPO}:pull&service=${REGISTRY}`;
  const body = JSON.parse((await readAll(await httpsGet(url))).toString());
  if (!body.token) throw new Error('GHCR 익명 토큰을 받지 못했습니다.');

  // expires_in 보다 60초 일찍 만료시켜 경계에서 401 나는 걸 피한다.
  const ttl = Math.max((body.expires_in || 300) - 60, 30);
  cachedToken = { token: body.token, expiresAt: Date.now() + ttl * 1000 };
  return body.token;
}

async function ghcrGet(pathname, extraHeaders = {}) {
  const token = await getAnonymousToken();
  return httpsGet(`https://${REGISTRY}/v2/${REPO}${pathname}`, {
    Authorization: `Bearer ${token}`,
    ...extraHeaders,
  });
}

// ── 아티팩트 조회 ─────────────────────────────────────────────────────────────

function findLayer(layers, predicate) {
  return layers.find((l) => predicate(l.annotations?.[TITLE_ANNOTATION] || ''));
}

/**
 * 주어진 태그의 OS 이미지 아티팩트 메타데이터. 바이너리는 받지 않는다.
 * 반환: { board, osVersion, version, revision, built, image:{file,digest,size}, releases }
 */
async function describeTag(tag) {
  const manifest = JSON.parse(
    (await readAll(await ghcrGet(`/manifests/${tag}`, { Accept: MANIFEST_ACCEPT }))).toString()
  );

  const layers = manifest.layers || [];
  const imageLayer = findLayer(layers, (t) => t.endsWith('.img.xz'));
  if (!imageLayer) throw new Error('GHCR 아티팩트에 .img.xz 가 없습니다.');

  const releasesLayer = findLayer(layers, (t) => t === 'releases.json');
  let releases = null;
  if (releasesLayer) {
    try {
      releases = JSON.parse((await readAll(await ghcrGet(`/blobs/${releasesLayer.digest}`))).toString());
    } catch {
      releases = null; // 부가 정보일 뿐 — 없다고 굽기를 막지는 않는다.
    }
  }

  const a = manifest.annotations || {};
  return {
    ref: `${REGISTRY}/${REPO}:${tag}`,
    board: a['io.clawlink.board'] || releases?.board || 'opizero3',
    osVersion: a['io.clawlink.os_version'] || releases?.os_version || '',
    version: a['org.opencontainers.image.version'] || releases?.version || '',
    revision: a['org.opencontainers.image.revision'] || releases?.revision || '',
    built: a['io.clawlink.built'] || releases?.date || '',
    osBase: releases?.os_base || '',
    docker: releases?.docker || [],
    image: {
      file: imageLayer.annotations[TITLE_ANNOTATION],
      digest: imageLayer.digest,          // "sha256:<hex>"
      sha256: imageLayer.digest.replace(/^sha256:/, ''),
      size: imageLayer.size,
    },
  };
}

/** 하위호환 — 옛 단일보드(opizero3) 태그 없는 `latest` 조회. */
async function describeLatest() {
  return describeTag(TAG);
}

/** 보드 하나의 최신 이미지 — `<board>-latest`, opizero3 는 실패 시 구태그로 폴백. */
async function describeBoard(board) {
  try {
    return await describeTag(`${board}-latest`);
  } catch (e) {
    if (board === LEGACY_TAG_BOARD) return describeTag(TAG);
    throw e;
  }
}

/** 발행된 모든 보드의 최신 이미지 목록 — 미발행 보드는 조용히 제외(imager#31 "준비중" UI). */
async function describeAllBoards() {
  const settled = await Promise.allSettled(KNOWN_BOARDS.map((b) => describeBoard(b)));
  return settled
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);
}

// ── 다운로드 + 검증 ───────────────────────────────────────────────────────────

function hashingTransform(hash, onBytes) {
  return new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

// 진행률 콜백을 매 청크마다 IPC로 쏘면 렌더러가 밀린다 — 1%가 바뀔 때만 보낸다.
function throttledPercent(total, report) {
  let done = 0;
  let last = -1;
  return (n) => {
    done += n;
    const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
    if (pct !== last) { last = pct; report(pct); }
  };
}

async function sha256OfFile(filePath, total, onPercent) {
  const hash = crypto.createHash('sha256');
  const bump = throttledPercent(total, onPercent);
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
    bump(chunk.length);
  }
  return hash.digest('hex');
}

/**
 * 이미지를 캐시에 준비한다. 이미 받아둔 게 있고 sha256이 맞으면 다시 받지 않는다.
 * onProgress({ stage: 'verifying'|'downloading', percent })
 * 반환: { path, fileName, cached, sha256 }
 */
async function prepareImage({ cacheDir, info, onProgress = () => {} }) {
  const { file, sha256, size, digest } = info.image;
  const dest = path.join(cacheDir, file);

  fs.mkdirSync(cacheDir, { recursive: true });

  // 캐시 히트 — 크기가 맞을 때만 해시를 돌린다(275MB 해시는 공짜가 아니다).
  if (fs.existsSync(dest) && fs.statSync(dest).size === size) {
    const actual = await sha256OfFile(dest, size, (p) => onProgress({ stage: 'verifying', percent: p }));
    if (actual === sha256) return { path: dest, fileName: file, cached: true, sha256 };
    fs.unlinkSync(dest); // 손상됨 — 버리고 다시 받는다
  }

  const part = `${dest}.part`;
  const hash = crypto.createHash('sha256');
  const bump = throttledPercent(size, (p) => onProgress({ stage: 'downloading', percent: p }));

  const res = await ghcrGet(`/blobs/${digest}`);
  try {
    await pipeline(res, hashingTransform(hash, bump), fs.createWriteStream(part));
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }

  const actual = hash.digest('hex');
  if (actual !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`이미지 무결성 검증 실패 — 받은 파일의 sha256이 다릅니다.\n기대: ${sha256}\n실제: ${actual}`);
  }

  fs.renameSync(part, dest);
  return { path: dest, fileName: file, cached: false, sha256 };
}

module.exports = { describeLatest, describeBoard, describeAllBoards, prepareImage, REPO, TAG };
