/**
 * z.ai 请求签名（HMAC-SHA256 双哈希）。
 *
 * ⚠️ **两站同一套签名** —— 真机实测（登录态、两站各自抓包）国区站发出的
 * `X-Signature` 与本模块用 `ZAI_SIGNATURE_SECRET` 现算的值逐字一致，
 * 所以密钥与算法都不分站点。
 *
 * 算法与 zhipu-ai-proxy/proxy/intl-sign.js、GLM-Free-API zai.go 一致，
 * 测试向量见 tests/zai.test.ts。
 *
 * 实现要点（任一条写错都会导致签名全错）：
 * 1. 第二层 HMAC 的 key 是 wKey 的 hex 字符串本身（UTF-8 字节），
 *    不是 wKey 解码后的字节。
 * 2. sortedPayload 只含 {requestId, timestamp, user_id} 三者，按 key 排序，
 *    拼成 "key,value" 逗号连接。
 * 3. dataToSign = sortedPayload + "|" + base64(trim(prompt)) + "|" + timestamp。
 */

import {
  ZAI_SIGNATURE_SECRET,
  ZAI_SIGNATURE_TIME_SLOT_MS,
} from './contracts';

const encoder = new TextEncoder();

export interface ZaiSignatureComponents {
  requestId: string;
  timestamp: string;
  userId: string;
}

// ---------------------------------------------------------------------------
// 纯 TypeScript SHA-256 / HMAC-SHA256（浏览器可用，无 Node crypto 依赖）。
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256(bytes: Uint8Array): Uint8Array {
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 4, bitLen >>> 0);

  const h = new Uint32Array(SHA256_H0);
  const w = new Uint32Array(64);

  for (let i = 0; i < paddedLen; i += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    let a = h[0], b = h[1], c = h[2], d = h[3];
    let e = h[4], f = h[5], g = h[6], hh = h[7];

    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) odv.setUint32(i * 4, h[i]);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

function hmacSha256Hex(keyBytes: Uint8Array, dataBytes: Uint8Array): string {
  const blockSize = 64;
  const key = keyBytes.length > blockSize ? sha256(keyBytes) : keyBytes;

  const ikey = new Uint8Array(blockSize);
  const okey = new Uint8Array(blockSize);
  ikey.set(key);
  okey.set(key);
  for (let i = 0; i < blockSize; i += 1) {
    ikey[i] ^= 0x36;
    okey[i] ^= 0x5c;
  }

  const inner = sha256(concatBytes(ikey, dataBytes));
  const outer = sha256(concatBytes(okey, inner));
  return toHex(outer);
}

// ---------------------------------------------------------------------------
// Base64（浏览器 btoa 的语义，处理 UTF-8）。
// ---------------------------------------------------------------------------

function utf8ToBase64(value: string): string {
  const bytes = encoder.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// 签名构建
// ---------------------------------------------------------------------------

export function buildZaiSortedPayload(components: ZaiSignatureComponents): string {
  const entries: Array<[string, string]> = [
    ['requestId', components.requestId],
    ['timestamp', components.timestamp],
    ['user_id', components.userId],
  ];
  entries.sort(([left], [right]) => left.localeCompare(right));
  return entries.map(([key, value]) => `${key},${value}`).join(',');
}

export function computeZaiTimeSlot(timestampMs: number): number {
  return Math.floor(timestampMs / ZAI_SIGNATURE_TIME_SLOT_MS);
}

/**
 * 计算签名。`prompt` 是权威 prompt（signature_prompt 当前值）。
 * 注意：增强 prompt 后必须先重算 `X-Signature`，否则服务端忽略改动。
 */
export function createZaiSignature(
  sortedPayload: string,
  prompt: string,
  timestamp: string,
): string {
  const timestampMs = Number(timestamp);
  const timeSlot = Number.isFinite(timestampMs) ? computeZaiTimeSlot(timestampMs) : 0;

  // 第一层：wKey = hex(HMAC-SHA256(SECRET, String(timeSlot)))
  const wKey = hmacSha256Hex(
    encoder.encode(ZAI_SIGNATURE_SECRET),
    encoder.encode(String(timeSlot)),
  );

  // 数据：sortedPayload + "|" + base64(trim(prompt)) + "|" + timestamp
  const promptBase64 = utf8ToBase64(prompt.trim());
  const dataToSign = `${sortedPayload}|${promptBase64}|${timestamp}`;

  // 第二层：signature = hex(HMAC-SHA256(wKeyHexAsUtf8, dataToSign))
  return hmacSha256Hex(encoder.encode(wKey), encoder.encode(dataToSign));
}

/**
 * 为一条增强后的请求 body 重算签名：读取 body 里的 `signature_prompt`、
 * 以及 query 里的 `timestamp` / `requestId` / `user_id`，产出新的 `X-Signature`。
 *
 * 读不到 `signature_prompt`、或 URL 里缺这三个参数时返回 `null` —— 调用方据此
 * **不重签名**、沿用页面自己那份 `X-Signature`。
 *
 * ⚠️ **`url` 可能是相对路径**（fetch hook 拿到的就是这种形态）⇒ 传 `baseUrl`
 * 兜底；不传时只能解析绝对 URL，相对路径会走 `null` 那条路。
 */
export function resignZaiCompletionRequest(
  url: string,
  body: Record<string, unknown>,
  baseUrl?: string,
): { url: string; signature: string } | null {
  const prompt = typeof body.signature_prompt === 'string' ? body.signature_prompt : null;
  if (prompt === null) return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url, baseUrl);
  } catch {
    return null;
  }

  const timestamp = parsedUrl.searchParams.get('timestamp');
  const requestId = parsedUrl.searchParams.get('requestId');
  const userId = parsedUrl.searchParams.get('user_id');
  if (!timestamp || !requestId || !userId) return null;

  const signature = createZaiSignature(
    buildZaiSortedPayload({ requestId, timestamp, userId }),
    prompt,
    timestamp,
  );

  // 签名换了，URL 里的 signature_timestamp 也要跟着换。
  parsedUrl.searchParams.set('signature_timestamp', timestamp);
  return { url: parsedUrl.href, signature };
}