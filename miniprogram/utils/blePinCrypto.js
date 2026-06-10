const BLE_PIN_KEY_SALT = "YUNTING-ZHIJIA-BLE-PIN-KEY-V1";
const BLE_PIN_SUITE = "YTS-BLE-PIN-SHA256-AES128CCM-V1";
const BLE_PROTO = "YTS-BLE/1";
const CCM_TAG_LENGTH = 16;
const CCM_NONCE_LENGTH = 12;
const BLE_SEQ_KEY_PREFIX = "yuntingBleSeq";

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const AES_SBOX = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];

const AES_RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
const B64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
let memorySeq = 0;

function utf8Bytes(text) {
  const encoded = encodeURIComponent(String(text));
  const bytes = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const char = encoded[index];
    if (char === "%") {
      bytes.push(parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }
  return new Uint8Array(bytes);
}

function bytesToHex(bytes) {
  return Array.prototype.map.call(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const text = String(hex || "").trim();
  if (!/^[0-9a-fA-F]*$/.test(text) || text.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64UrlEncode(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const value = (b0 << 16) | (b1 << 8) | b2;
    output += B64URL_CHARS[(value >>> 18) & 0x3f];
    output += B64URL_CHARS[(value >>> 12) & 0x3f];
    if (index + 1 < bytes.length) {
      output += B64URL_CHARS[(value >>> 6) & 0x3f];
    }
    if (index + 2 < bytes.length) {
      output += B64URL_CHARS[value & 0x3f];
    }
  }
  return output;
}

function base64UrlDecode(text) {
  const clean = String(text || "").replace(/=/g, "");
  const bytes = [];
  for (let index = 0; index < clean.length; index += 4) {
    const c0 = B64URL_CHARS.indexOf(clean[index]);
    const c1 = B64URL_CHARS.indexOf(clean[index + 1]);
    const c2 = B64URL_CHARS.indexOf(clean[index + 2]);
    const c3 = B64URL_CHARS.indexOf(clean[index + 3]);
    if (c0 < 0 || c1 < 0) {
      break;
    }
    const value = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
    bytes.push((value >>> 16) & 0xff);
    if (c2 >= 0) {
      bytes.push((value >>> 8) & 0xff);
    }
    if (c3 >= 0) {
      bytes.push(value & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function canonicalStringify(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item === undefined ? null : item)).join(",")}]`;
  }
  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return JSON.stringify(value);
  }
  if (valueType === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined && typeof value[key] !== "function").sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
  }
  return "null";
}

function rightRotate(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Bytes(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const length = input.length;
  const withOne = length + 1;
  const zeroPad = (withOne % 64 <= 56) ? (56 - (withOne % 64)) : (120 - (withOne % 64));
  const total = withOne + zeroPad + 8;
  const msg = new Uint8Array(total);
  msg.set(input);
  msg[length] = 0x80;
  const bitLenHi = Math.floor(length / 0x20000000);
  const bitLenLo = (length << 3) >>> 0;
  msg[total - 8] = (bitLenHi >>> 24) & 0xff;
  msg[total - 7] = (bitLenHi >>> 16) & 0xff;
  msg[total - 6] = (bitLenHi >>> 8) & 0xff;
  msg[total - 5] = bitLenHi & 0xff;
  msg[total - 4] = (bitLenLo >>> 24) & 0xff;
  msg[total - 3] = (bitLenLo >>> 16) & 0xff;
  msg[total - 2] = (bitLenLo >>> 8) & 0xff;
  msg[total - 1] = bitLenLo & 0xff;

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Array(64);

  for (let offset = 0; offset < total; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const pos = offset + index * 4;
      w[index] = ((msg[pos] << 24) | (msg[pos + 1] << 16) | (msg[pos + 2] << 8) | msg[pos + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = (rightRotate(w[index - 15], 7) ^ rightRotate(w[index - 15], 18) ^ (w[index - 15] >>> 3)) >>> 0;
      const s1 = (rightRotate(w[index - 2], 17) ^ rightRotate(w[index - 2], 19) ^ (w[index - 2] >>> 10)) >>> 0;
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const s1 = (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + SHA256_K[index] + w[index]) >>> 0;
      const s0 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, index) => {
    out[index * 4] = (word >>> 24) & 0xff;
    out[index * 4 + 1] = (word >>> 16) & 0xff;
    out[index * 4 + 2] = (word >>> 8) & 0xff;
    out[index * 4 + 3] = word & 0xff;
  });
  return out;
}

function sha256Hex(text) {
  return bytesToHex(sha256Bytes(utf8Bytes(text)));
}

function deriveBleAesKey(deviceNo, pin) {
  const normalizedDeviceNo = String(deviceNo || "").trim().toUpperCase();
  const normalizedPin = String(pin || "").trim();
  if (!/^\d{4,8}$/.test(normalizedPin)) {
    throw new Error("设备 PIN 格式不正确");
  }
  const keyMaterial = `${normalizedDeviceNo}|${normalizedPin}|${BLE_PIN_KEY_SALT}`;
  const hash = sha256Bytes(utf8Bytes(keyMaterial));
  return {
    key: hash.slice(0, 16),
    keyMaterial,
    keyMaterialSha256Hex: bytesToHex(hash),
    keyHex: bytesToHex(hash.slice(0, 16)),
  };
}

function expandAes128Key(key) {
  if (!key || key.length !== 16) {
    throw new Error("AES-128 key must be 16 bytes");
  }
  const expanded = new Uint8Array(176);
  expanded.set(key);
  let bytesGenerated = 16;
  let rconIndex = 1;
  const temp = new Uint8Array(4);
  while (bytesGenerated < 176) {
    temp.set(expanded.slice(bytesGenerated - 4, bytesGenerated));
    if (bytesGenerated % 16 === 0) {
      const first = temp[0];
      temp[0] = AES_SBOX[temp[1]] ^ AES_RCON[rconIndex];
      temp[1] = AES_SBOX[temp[2]];
      temp[2] = AES_SBOX[temp[3]];
      temp[3] = AES_SBOX[first];
      rconIndex += 1;
    }
    for (let index = 0; index < 4; index += 1) {
      expanded[bytesGenerated] = expanded[bytesGenerated - 16] ^ temp[index];
      bytesGenerated += 1;
    }
  }
  return expanded;
}

function addRoundKey(state, expanded, round) {
  const offset = round * 16;
  for (let index = 0; index < 16; index += 1) {
    state[index] ^= expanded[offset + index];
  }
}

function subBytes(state) {
  for (let index = 0; index < 16; index += 1) {
    state[index] = AES_SBOX[state[index]];
  }
}

function shiftRows(state) {
  const t = state.slice();
  state[1] = t[5];
  state[5] = t[9];
  state[9] = t[13];
  state[13] = t[1];
  state[2] = t[10];
  state[6] = t[14];
  state[10] = t[2];
  state[14] = t[6];
  state[3] = t[15];
  state[7] = t[3];
  state[11] = t[7];
  state[15] = t[11];
}

function xtime(value) {
  return ((value << 1) ^ ((value & 0x80) ? 0x1b : 0)) & 0xff;
}

function mixColumns(state) {
  for (let col = 0; col < 4; col += 1) {
    const offset = col * 4;
    const a0 = state[offset];
    const a1 = state[offset + 1];
    const a2 = state[offset + 2];
    const a3 = state[offset + 3];
    const m2a0 = xtime(a0);
    const m2a1 = xtime(a1);
    const m2a2 = xtime(a2);
    const m2a3 = xtime(a3);
    state[offset] = (m2a0 ^ (m2a1 ^ a1) ^ a2 ^ a3) & 0xff;
    state[offset + 1] = (a0 ^ m2a1 ^ (m2a2 ^ a2) ^ a3) & 0xff;
    state[offset + 2] = (a0 ^ a1 ^ m2a2 ^ (m2a3 ^ a3)) & 0xff;
    state[offset + 3] = ((m2a0 ^ a0) ^ a1 ^ a2 ^ m2a3) & 0xff;
  }
}

function aesEncryptBlock(key, block) {
  if (!block || block.length !== 16) {
    throw new Error("AES block must be 16 bytes");
  }
  const expanded = expandAes128Key(key);
  const state = new Uint8Array(block);
  addRoundKey(state, expanded, 0);
  for (let round = 1; round < 10; round += 1) {
    subBytes(state);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, expanded, round);
  }
  subBytes(state);
  shiftRows(state);
  addRoundKey(state, expanded, 10);
  return state;
}

function xorBlock(left, right) {
  const out = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    out[index] = (left[index] || 0) ^ (right[index] || 0);
  }
  return out;
}

function encodeLength(value, byteCount) {
  const bytes = new Uint8Array(byteCount);
  let remaining = value;
  for (let index = byteCount - 1; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  if (remaining) {
    throw new Error("length too large");
  }
  return bytes;
}

function ccmCounterBlock(nonce, counter) {
  const block = new Uint8Array(16);
  block[0] = 2;
  block.set(nonce, 1);
  block.set(encodeLength(counter, 3), 13);
  return block;
}

function buildCcmB0(nonce, plaintextLength, hasAad) {
  const block = new Uint8Array(16);
  block[0] = (hasAad ? 0x40 : 0) | (((CCM_TAG_LENGTH - 2) / 2) << 3) | 2;
  block.set(nonce, 1);
  block.set(encodeLength(plaintextLength, 3), 13);
  return block;
}

function paddedBlocks(bytes) {
  const blocks = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const block = new Uint8Array(16);
    block.set(bytes.slice(offset, Math.min(offset + 16, bytes.length)));
    blocks.push(block);
  }
  return blocks;
}

function encodeAad(aad) {
  if (!aad || !aad.length) {
    return new Uint8Array(0);
  }
  if (aad.length >= 0xff00) {
    throw new Error("AAD too large");
  }
  const encoded = new Uint8Array(2 + aad.length);
  encoded[0] = (aad.length >>> 8) & 0xff;
  encoded[1] = aad.length & 0xff;
  encoded.set(aad, 2);
  return encoded;
}

function aesCcmEncrypt(key, nonce, plaintext, aad) {
  if (!nonce || nonce.length !== CCM_NONCE_LENGTH) {
    throw new Error("BLE CCM nonce must be 12 bytes");
  }
  if (plaintext.length >= 0x1000000) {
    throw new Error("BLE plaintext too large");
  }
  const hasAad = !!(aad && aad.length);
  let y = aesEncryptBlock(key, buildCcmB0(nonce, plaintext.length, hasAad));
  if (hasAad) {
    const aadBlocks = paddedBlocks(encodeAad(aad));
    aadBlocks.forEach((block) => {
      y = aesEncryptBlock(key, xorBlock(y, block));
    });
  }
  const plainBlocks = paddedBlocks(plaintext);
  plainBlocks.forEach((block) => {
    y = aesEncryptBlock(key, xorBlock(y, block));
  });
  const s0 = aesEncryptBlock(key, ccmCounterBlock(nonce, 0));
  const tag = new Uint8Array(CCM_TAG_LENGTH);
  for (let index = 0; index < CCM_TAG_LENGTH; index += 1) {
    tag[index] = y[index] ^ s0[index];
  }

  const ciphertext = new Uint8Array(plaintext.length);
  for (let offset = 0, counter = 1; offset < plaintext.length; offset += 16, counter += 1) {
    const stream = aesEncryptBlock(key, ccmCounterBlock(nonce, counter));
    const end = Math.min(offset + 16, plaintext.length);
    for (let index = offset; index < end; index += 1) {
      ciphertext[index] = plaintext[index] ^ stream[index - offset];
    }
  }
  return { ciphertext, tag };
}

function nextBleSequence(deviceNo) {
  const key = `${BLE_SEQ_KEY_PREFIX}_${String(deviceNo || "unknown").toUpperCase()}`;
  if (typeof wx !== "undefined" && wx.getStorageSync && wx.setStorageSync) {
    const next = (Number(wx.getStorageSync(key)) || 0) + 1;
    wx.setStorageSync(key, next);
    return next;
  }
  memorySeq += 1;
  return memorySeq;
}

function createNonce(ts, seq) {
  const nonce = new Uint8Array(CCM_NONCE_LENGTH);
  let timestamp = Number(ts) || Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    nonce[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  let sequence = Number(seq) || 0;
  for (let index = 9; index >= 6; index -= 1) {
    nonce[index] = sequence & 0xff;
    sequence >>>= 8;
  }
  const random = Math.floor(Math.random() * 0x10000);
  nonce[10] = (random >>> 8) & 0xff;
  nonce[11] = random & 0xff;
  return nonce;
}

function createBleSecureFrame(options) {
  const deviceNo = String(options.deviceNo || "").trim().toUpperCase();
  const msgType = String(options.msgType || (options.payload && options.payload.type) || "").trim();
  const ts = Number(options.ts || (options.payload && options.payload.ts) || Date.now());
  const seq = Number(options.seq || nextBleSequence(deviceNo));
  const nonce = options.nonceHex ? hexToBytes(options.nonceHex) : createNonce(ts, seq);
  const nonceHex = bytesToHex(nonce);
  const keyInfo = deriveBleAesKey(deviceNo, options.pin);
  const aadObj = {
    deviceNo,
    msgType,
    nonce: nonceHex,
    proto: BLE_PROTO,
    seq,
    ts,
  };
  const plaintext = utf8Bytes(canonicalStringify(options.payload || {}));
  const aad = utf8Bytes(canonicalStringify(aadObj));
  const encrypted = aesCcmEncrypt(keyInfo.key, nonce, plaintext, aad);
  return {
    v: 1,
    proto: BLE_PROTO,
    msgType,
    seq,
    ts,
    nonce: nonceHex,
    ciphertext: base64UrlEncode(encrypted.ciphertext),
    tag: base64UrlEncode(encrypted.tag),
  };
}

function selfTestVector() {
  const frame = createBleSecureFrame({
    deviceNo: "YT-AW-00000-A324",
    pin: "123456",
    msgType: "provision.wifi",
    seq: 1,
    ts: 1710000000000,
    nonceHex: "000102030405060708090a0b",
    payload: {
      apiUrl: "https://yutingsmarthome.xin/api",
      deviceNo: "YT-AW-00000-A324",
      heartbeatIntervalMs: 90000,
      password: "wifi-password",
      provisionSessionId: "ps_test_vector_001",
      secureProtocol: "YTS-SEC/1-AES-128-CCM",
      ssid: "Home-WiFi",
      ts: 1710000000000,
      type: "provision.wifi",
    },
  });
  return {
    keyMaterialSha256Hex: sha256Hex("YT-AW-00000-A324|123456|YUNTING-ZHIJIA-BLE-PIN-KEY-V1"),
    bleAesKeyHex: deriveBleAesKey("YT-AW-00000-A324", "123456").keyHex,
    ciphertextHex: bytesToHex(base64UrlDecode(frame.ciphertext)),
    tagHex: bytesToHex(base64UrlDecode(frame.tag)),
  };
}

module.exports = {
  BLE_PIN_KEY_SALT,
  BLE_PIN_SUITE,
  BLE_PROTO,
  canonicalStringify,
  createBleSecureFrame,
  deriveBleAesKey,
  selfTestVector,
};
