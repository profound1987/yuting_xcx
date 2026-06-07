const SESSION_KEY = "yuntingSession";
const DEVICES_KEY_PREFIX = "yuntingDevices";
const { callApi, apiConfig, getLastHttpRequestUrl } = require("../../services/apiClient");

const DEVICE_TYPES = [
  { label: "智能浇水设备", value: "watering", code: "AW" },
  { label: "环境传感器", value: "sensor", code: "ES" },
  { label: "智能灯控", value: "light", code: "LC" },
  { label: "智能插座", value: "socket", code: "SP" },
  { label: "智能网关", value: "gateway", code: "GW" },
];

const DEVICE_NO_PATTERN = /^YT-([A-Z]{2})-([0-9A-F]{5})-([0-9A-F]{4})$/;
const DEVICE_CODE_SALT = "YUNTING-ZHIJIA-DEVICE-CODE-V1";
const CRC32_TABLE = createCrc32Table();
const DEVICE_NO_ERROR = "设备号不正确";
const DEVICE_ALREADY_BOUND_ERROR = "设备已被绑定，请联系管理员解绑";
const DEVICE_ALREADY_OWNED_ERROR = "该设备已经是你的设备，可在设备管理中查看";
const PROVISION_SERVICE_UUID = "0000FFF0-0000-1000-8000-00805F9B34FB";
const PROVISION_WRITE_UUID = "0000FFF1-0000-1000-8000-00805F9B34FB";
const PROVISION_NOTIFY_UUID = "0000FFF2-0000-1000-8000-00805F9B34FB";
const DEFAULT_PROVISION_POLL_INTERVAL_MS = 2000;
const DEFAULT_PROVISION_TIMEOUT_MS = 120000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_WIFI_STATUS_TIMEOUT_MS = 60000;
const DEFAULT_DEVICE_VERIFY_TIMEOUT_MS = 3000;
const BLE_DEVICE_TTL_MS = 8000;
const BLE_INVALID_RSSI = 0;

function createCrc32Table() {
  const table = [];
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[index] = crc >>> 0;
  }
  return table;
}

function crc32(text) {
  let crc = 0xffffffff;
  const input = text.toUpperCase();
  for (let index = 0; index < input.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ input.charCodeAt(index)) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function getCheckCode(body) {
  return crc32(`${body}|${DEVICE_CODE_SALT}`).slice(4);
}

function normalizeDeviceNo(value) {
  return (value || "").trim().toUpperCase();
}

function extractDeviceNo(text) {
  const matched = normalizeDeviceNo(text).match(/YT-[A-Z]{2}-[0-9A-F]{5}-[0-9A-F]{4}/);
  return matched ? matched[0] : "";
}

function getDeviceTypeByCode(code) {
  return DEVICE_TYPES.find((item) => item.code === code);
}

function getDeviceTypeLabel(type) {
  const matched = DEVICE_TYPES.find((item) => item.value === type);
  return matched ? matched.label : "未知设备";
}

function parseDeviceNo(value) {
  const deviceNo = normalizeDeviceNo(value);
  const matched = deviceNo.match(DEVICE_NO_PATTERN);
  if (!matched) {
    return { valid: false, message: DEVICE_NO_ERROR };
  }

  const typeCode = matched[1];
  const serial = matched[2];
  const checkCode = matched[3];
  const body = `YT-${typeCode}-${serial}`;
  if (checkCode !== getCheckCode(body)) {
    return { valid: false, message: DEVICE_NO_ERROR };
  }

  const deviceType = getDeviceTypeByCode(typeCode);
  if (!deviceType) {
    return { valid: false, message: DEVICE_NO_ERROR };
  }

  return { valid: true, deviceNo, typeCode, serial, deviceType };
}

function getDevicesKey(phone) {
  return `${DEVICES_KEY_PREFIX}_${phone}`;
}

function getStoredDevices(phone) {
  return wx.getStorageSync(getDevicesKey(phone)) || [];
}

function setStoredDevices(phone, devices) {
  wx.setStorageSync(getDevicesKey(phone), devices);
}

function createWateringConfig() {
  return {
    mode: "demand",
    demand: { intervalHours: 4, threshold: 35, durationSeconds: 20 },
    schedule: { intervalDays: 1, times: 2, durationSeconds: 30 },
    manual: { durationSeconds: 10 },
  };
}

function createDeviceFromRemote(parsed, deviceName, remoteDevice) {
  const now = Date.now();
  const device = remoteDevice || {};
  const type = device.type || parsed.deviceType.value;
  return {
    id: device.id || `device_${now}`,
    deviceNo: parsed.deviceNo,
    deviceSerial: device.deviceSerial || parsed.serial,
    deviceTypeCode: device.deviceTypeCode || parsed.typeCode,
    name: device.name || deviceName || parsed.deviceType.label,
    ownerPhone: device.ownerPhone || "",
    type,
    typeLabel: device.typeLabel || getDeviceTypeLabel(type),
    status: device.status || "在线",
    online: device.online !== false,
    bindStatus: device.bindStatus || "bound",
    mockScenario: device.mockScenario || "",
    createdAt: device.createdAt || now,
    updatedAt: device.updatedAt || now,
    lastWateringAt: device.lastWateringAt || "--",
    lastSyncedAt: device.lastSyncedAt || null,
    heartbeatIntervalMs: device.heartbeatIntervalMs || null,
    heartbeatTimeoutMs: device.heartbeatTimeoutMs || null,
    lastHeartbeatAt: device.lastHeartbeatAt || null,
    lastBootAt: device.lastBootAt || null,
    lastSeenAt: device.lastSeenAt || null,
    telemetry: device.telemetry || {},
    syncState: device.syncState || (device.online === false ? "offline" : "synced"),
    config: type === "watering" ? (device.config || createWateringConfig()) : (device.config || {}),
  };
}

function stringToUtf8Bytes(text) {
  const encoded = encodeURIComponent(text);
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

function toBufferChunks(bytes, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    const chunk = new Uint8Array(end - offset);
    chunk.set(bytes.subarray(offset, end));
    chunks.push(chunk.buffer);
  }
  return chunks;
}

function encodePayloadChunks(payload) {
  const bytes = stringToUtf8Bytes(`${JSON.stringify(payload)}\n`);
  return toBufferChunks(bytes, 20);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProvisionErrorCode(code) {
  const text = String(code || "").trim().toUpperCase();
  const aliases = {
    WIFI_SSID_NOT_FOUND: "WIFI_NOT_FOUND",
    SSID_NOT_FOUND: "WIFI_NOT_FOUND",
    AP_NOT_FOUND: "WIFI_NOT_FOUND",
    WIFI_AP_NOT_FOUND: "WIFI_NOT_FOUND",
    NO_AP_FOUND: "WIFI_NOT_FOUND",
    WIFI_SCAN_NOT_FOUND: "WIFI_NOT_FOUND",
    WIFI_CONNECT_TIMEOUT: "WIFI_TIMEOUT",
    WIFI_CONNECTION_TIMEOUT: "WIFI_TIMEOUT",
    WIFI_AUTH_ERROR: "WIFI_AUTH_FAILED",
    WIFI_PASSWORD_ERROR: "WIFI_AUTH_FAILED",
    WIFI_WRONG_PASSWORD: "WIFI_AUTH_FAILED",
  };
  return aliases[text] || text;
}

function getProvisionErrorMessage(code, fallback) {
  const normalizedCode = normalizeProvisionErrorCode(code);
  const map = {
    BLE_NOT_AVAILABLE: "当前设备不支持或未开启蓝牙，请开启蓝牙后重试",
    BLE_SCAN_TIMEOUT: "未发现可配置设备，请确认设备已进入配网模式",
    BLE_CONNECT_FAILED: "蓝牙连接失败，该设备可能已退出配网模式，请确认设备仍在广播后重试",
    BLE_WRITE_FAILED: "蓝牙通信失败，请确认设备仍在配网模式后重试",
    BLE_STALE_DEVICE: "设备广播已失效，请确认设备仍在配网模式，正在重新扫描",
    DEVICE_NO_MISMATCH: "设备号与当前设备不匹配，请检查后重新配置",
    DEVICE_VERIFY_FAILED: "设备校验失败，请联系售后",
    BLE_STATUS_NOTIFY_UNAVAILABLE: "设备未开启 BLE 状态回传，请确认设备固件版本",
    BLE_WIFI_STATUS_TIMEOUT: "未收到设备 Wi‑Fi 连接结果，请检查设备是否仍在配网模式",
    WIFI_NOT_CONNECTED: "请先把手机连接到要给设备使用的同一个 Wi‑Fi，或手动输入 Wi‑Fi 名称",
    WIFI_SSID_REQUIRED: "请输入 Wi‑Fi 名称",
    WIFI_PASSWORD_REQUIRED: "请输入 Wi‑Fi 密码",
    WIFI_FAILED: "设备 Wi‑Fi 连接失败，请检查 Wi‑Fi 信息和设备状态",
    WIFI_NOT_FOUND: "未找到该 Wi‑Fi，请确认 Wi‑Fi 名称是否正确，并让设备靠近路由器",
    WIFI_AUTH_FAILED: "Wi‑Fi 连接失败，请检查密码",
    WIFI_TIMEOUT: "Wi‑Fi 连接超时，请靠近路由器后重试",
    CLOUD_CONNECT_FAILED: "设备无法连接云端服务器，请检查网络",
    CLOUD_DEVICE_AUTH_FAILED: "设备云端认证失败，请联系售后",
    CLOUD_REPORT_TIMEOUT: "未收到设备上线确认，请稍后重试",
    DEVICE_PROVISION_PENDING: "正在等待设备上线",
    DEVICE_READY_TO_BIND: "设备已上线，可以绑定",
    DEVICE_PROVISION_TIMEOUT: "设备未上线，请检查网络是否正常",
    DEVICE_NOT_READY_TO_BIND: "设备未上线，请检查网络",
    PROVISION_SESSION_NOT_FOUND: "请重新配置设备",
    PROVISION_SESSION_EXPIRED: "配网超时，请重新配置",
    PROVISION_SESSION_MISMATCH: "请重新配置设备",
    DEVICE_AUTH_FAILED: "设备认证失败，请联系售后",
    DEVICE_REPLAY_DETECTED: "设备认证失败，请联系售后",
    DEVICE_KEY_NOT_FOUND: "设备未注册或暂不可用",
    PROVISION_TIMEOUT: "配置超时，请重新配置",
  };
  return map[normalizedCode] || fallback || "配置失败，请稍后重试";
}

function arrayBufferToBytes(buffer) {
  if (!buffer) {
    return [];
  }
  try {
    return Array.prototype.slice.call(new Uint8Array(buffer));
  } catch (error) {
    return [];
  }
}

function bytesToText(bytes) {
  if (!bytes || !bytes.length) {
    return "";
  }
  const encoded = bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  try {
    return decodeURIComponent(encoded).replace(/\u0000/g, "").trim();
  } catch (error) {
    return bytes
      .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ""))
      .join("")
      .trim();
  }
}

function bufferToUtf8Text(buffer) {
  const bytes = arrayBufferToBytes(buffer);
  if (!bytes.length) {
    return "";
  }
  const encoded = bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  try {
    return decodeURIComponent(encoded).replace(/\u0000/g, "");
  } catch (error) {
    return bytes.map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "")).join("");
  }
}

function normalizeUuid(value) {
  return String(value || "").toUpperCase();
}

function normalizeBleWifiStatus(payload) {
  const status = String((payload && (payload.status || payload.state || payload.result)) || "").toLowerCase();
  const code = normalizeProvisionErrorCode((payload && payload.code) || status);
  if (["connected", "success", "ok", "wifi_connected"].indexOf(status) >= 0 || code === "OK" || code === "WIFI_CONNECTED") {
    return "connected";
  }
  if (["failed", "error", "fail", "timeout"].indexOf(status) >= 0
    || ["WIFI_NOT_FOUND", "WIFI_AUTH_FAILED", "WIFI_TIMEOUT", "CLOUD_CONNECT_FAILED", "TLS_FAILED"].indexOf(code) >= 0
    || /FAILED|ERROR|TIMEOUT|MISMATCH/.test(code)) {
    return "failed";
  }
  if (["connecting", "scanning", "authenticating", "got_ip"].indexOf(status) >= 0) {
    return "progress";
  }
  return "unknown";
}

function getBleWifiStatusMessage(payload) {
  const code = normalizeProvisionErrorCode(payload && payload.code);
  return (payload && payload.message) || getProvisionErrorMessage(code, "设备正在连接 Wi‑Fi...");
}

function getBleWifiStatusError(payload) {
  const code = normalizeProvisionErrorCode(payload && (payload.code || payload.result || payload.status));
  return getProvisionErrorMessage(code, (payload && payload.message) || "设备 Wi‑Fi 连接失败");
}

function getBleWifiStatusType(payload) {
  const type = String((payload && payload.type) || "");
  return type === "wifiStatus" || type === "wifi.status" || type === "provisionWifi.status";
}

function getBleVerifyStatusType(payload) {
  const type = String((payload && payload.type) || "");
  const code = normalizeProvisionErrorCode(payload && payload.code);
  return type === "verifyDeviceNo"
    || type === "verifyDeviceNo.status"
    || type === "verifyDeviceNo.result"
    || type === "deviceVerify"
    || type === "device.verify"
    || code === "DEVICE_NO_MISMATCH"
    || code === "DEVICE_VERIFY_FAILED";
}

function normalizeBleVerifyStatus(payload) {
  const status = String((payload && (payload.status || payload.state || payload.result)) || "").toLowerCase();
  const code = normalizeProvisionErrorCode((payload && payload.code) || status);
  if (["ok", "success", "verified", "matched", "device_verified"].indexOf(status) >= 0 || code === "OK") {
    return "verified";
  }
  if (["failed", "error", "fail"].indexOf(status) >= 0 || code === "DEVICE_NO_MISMATCH" || code === "DEVICE_VERIFY_FAILED" || /MISMATCH|FAILED|ERROR/.test(code)) {
    return "failed";
  }
  return "unknown";
}

function getBleVerifyStatusError(payload) {
  const code = normalizeProvisionErrorCode(payload && (payload.code || payload.result || payload.status));
  return getProvisionErrorMessage(code, (payload && payload.message) || getProvisionErrorMessage("DEVICE_VERIFY_FAILED"));
}

function getHeartbeatIntervalMs(prepareData) {
  const value = Number(prepareData && prepareData.heartbeatIntervalMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_HEARTBEAT_INTERVAL_MS;
}

function getWifiStatusTimeoutMs(prepareData) {
  const value = Number(prepareData && prepareData.wifiStatusTimeoutMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WIFI_STATUS_TIMEOUT_MS;
}

function getAdvertisedName(advertisData) {
  const bytes = arrayBufferToBytes(advertisData);
  if (!bytes.length) {
    return "";
  }

  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes[offset];
    if (!length) {
      break;
    }
    const typeOffset = offset + 1;
    const type = bytes[typeOffset];
    const dataStart = offset + 2;
    const dataEnd = Math.min(offset + 1 + length, bytes.length);
    if ((type === 0x08 || type === 0x09) && dataEnd > dataStart) {
      const name = bytesToText(bytes.slice(dataStart, dataEnd));
      if (name) {
        return name;
      }
    }
    offset += length + 1;
  }
  return "";
}

function parseBleAdvertisedDeviceInfo(name) {
  const text = String(name || "").trim();
  if (!text) {
    return null;
  }

  const embeddedDeviceNo = extractDeviceNo(text);
  if (embeddedDeviceNo) {
    const parsed = parseDeviceNo(embeddedDeviceNo);
    if (parsed.valid) {
      return { deviceNo: parsed.deviceNo, typeCode: parsed.typeCode, serial: parsed.serial };
    }
  }

  const matched = text.toUpperCase().match(/^YTSH[-_]?([A-Z]{2})[-_]?([0-9A-F]{5})(?:[-_]?([0-9A-F]{4}))?/);
  if (!matched) {
    return null;
  }

  const typeCode = matched[1];
  const serial = matched[2];
  const body = `YT-${typeCode}-${serial}`;
  const deviceNo = `${body}-${getCheckCode(body)}`;
  const parsed = parseDeviceNo(deviceNo);
  if (!parsed.valid) {
    return null;
  }
  return { deviceNo: parsed.deviceNo, typeCode: parsed.typeCode, serial: parsed.serial };
}

function getBleDeviceInfo(device) {
  const rawName = ((device && device.name) || "").trim();
  const localName = ((device && device.localName) || "").trim();
  const advertisName = getAdvertisedName(device && device.advertisData);
  const name = rawName || localName || advertisName;
  let nameSource = "none";
  if (rawName) {
    nameSource = "name";
  } else if (localName) {
    nameSource = "localName";
  } else if (advertisName) {
    nameSource = "advertisData";
  }
  const advertisedDevice = parseBleAdvertisedDeviceInfo(name);
  return {
    name,
    rawName,
    localName,
    advertisName,
    nameSource,
    advertisedDeviceNo: advertisedDevice ? advertisedDevice.deviceNo : "",
    advertisedTypeCode: advertisedDevice ? advertisedDevice.typeCode : "",
    advertisedSerial: advertisedDevice ? advertisedDevice.serial : "",
  };
}

function isYtshBleName(name) {
  return (name || "").trim().toLowerCase().indexOf("ytsh") === 0;
}

function getValidBleRssi(device) {
  const value = Number(device && device.RSSI);
  if (!Number.isFinite(value) || value >= BLE_INVALID_RSSI) {
    return null;
  }
  return value;
}

Page({
  data: {
    phone: "",
    deviceNo: "",
    deviceName: "",
    parsedDevice: { valid: false },
    prepareData: null,
    bleDevices: [],
    selectedBleDevice: null,
    showBleDeviceDialog: false,
    showWifiDialog: false,
    wifiSsid: "",
    wifiManualMode: false,
    wifiManualSsid: "",
    wifiPassword: "",
    wifiPasswordVisible: false,
    sessionDevBypass: false,
    statusMessage: "请先确认设备号和设备名称，然后开始配置。",
    statusType: "info",
    steps: [
      { key: "check", title: "云端归属检查", desc: "确认设备已注册且未被其他账号绑定", status: "pending" },
      { key: "scan", title: "扫描 ytsh- 蓝牙设备", desc: "只展示进入配网模式的云汀智家设备", status: "pending" },
      { key: "wifi", title: "发送 Wi‑Fi 信息", desc: "通过 BLE 把 SSID 和密码发送给设备", status: "pending" },
      { key: "cloud", title: "设备连接云端", desc: "等待设备上线并完成云端认证", status: "pending" },
      { key: "bind", title: "完成绑定", desc: "云端确认成功后加入我的设备", status: "pending" },
    ],
  },

  onLoad(options) {
    const session = wx.getStorageSync(SESSION_KEY);
    if (!session || !session.phone) {
      wx.redirectTo({ url: "/pages/index/index" });
      return;
    }

    const deviceNo = normalizeDeviceNo(decodeURIComponent(options.deviceNo || ""));
    const deviceName = decodeURIComponent(options.deviceName || "").trim();
    this.setData({
      phone: session.phone,
      deviceNo,
      deviceName,
      sessionDevBypass: !!session.devBypass,
    }, this.refreshParsedDevice);
  },

  onUnload() {
    this.stopBleDiscovery();
    this.cleanupBleStatusNotify();
  },

  onDeviceNoInput(e) {
    this.setData({ deviceNo: normalizeDeviceNo(e.detail.value) }, this.refreshParsedDevice);
  },

  onDeviceNameInput(e) {
    this.setData({ deviceName: e.detail.value.trim() });
  },

  onWifiPasswordInput(e) {
    this.setData({ wifiPassword: e.detail.value });
  },

  onWifiSsidInput(e) {
    this.setData({ wifiManualSsid: e.detail.value });
  },

  enableManualWifiInput() {
    this.setData({ wifiManualMode: true });
    this.setStatus("请手动输入要给设备使用的 Wi‑Fi 名称和密码。", "info");
  },

  useDetectedWifi() {
    if (!this.data.wifiSsid) {
      return;
    }
    this.setData({ wifiManualMode: false, wifiManualSsid: "" });
    this.setStatus("已使用手机当前连接的 Wi‑Fi，请输入 Wi‑Fi 密码。", "info");
  },

  retryLoadWifiInfo() {
    this.setData({ wifiSsid: "", wifiManualMode: false, wifiManualSsid: "" });
    this.loadWifiInfo();
  },

  getEffectiveWifiSsid() {
    if (this.data.wifiManualMode) {
      return String(this.data.wifiManualSsid || "").trim();
    }
    return String(this.data.wifiSsid || "").trim();
  },

  toggleWifiPasswordVisible() {
    this.setData({ wifiPasswordVisible: !this.data.wifiPasswordVisible });
  },

  refreshParsedDevice() {
    const parsedDevice = parseDeviceNo(this.data.deviceNo);
    this.setData({ parsedDevice });
  },

  scanDeviceCode() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ["qrCode", "barCode"],
      success: (res) => {
        const deviceNo = extractDeviceNo(res.result);
        if (!deviceNo) {
          wx.showToast({ title: DEVICE_NO_ERROR, icon: "none" });
          return;
        }
        const parsed = parseDeviceNo(deviceNo);
        if (!parsed.valid) {
          wx.showToast({ title: parsed.message, icon: "none" });
          return;
        }
        this.setData({ deviceNo: parsed.deviceNo, parsedDevice: parsed });
        wx.showToast({ title: "已读取设备号" });
      },
    });
  },

  async startConfigure() {
    const parsed = parseDeviceNo(this.data.deviceNo);
    if (!parsed.valid) {
      this.setStatus(parsed.message, "error");
      wx.showToast({ title: parsed.message, icon: "none" });
      return;
    }

    if (!this.data.deviceName) {
      wx.showToast({ title: "请输入设备名称", icon: "none" });
      return;
    }

    const localDevices = getStoredDevices(this.data.phone);
    if (localDevices.some((item) => item.deviceNo === parsed.deviceNo)) {
      this.setStatus(DEVICE_ALREADY_OWNED_ERROR, "info");
      wx.showModal({ title: "设备已存在", content: DEVICE_ALREADY_OWNED_ERROR, showCancel: false });
      return;
    }

    this.cleanupBleStatusNotify();
    this.closeCurrentBleConnection();
    this.stopBleDiscovery();

    this.setData({
      parsedDevice: parsed,
      bleDevices: [],
      selectedBleDevice: null,
      showBleDeviceDialog: false,
      showWifiDialog: false,
      wifiSsid: "",
      wifiManualMode: false,
      wifiManualSsid: "",
      wifiPassword: "",
      wifiPasswordVisible: false,
    });
    this.resetSteps();
    this.setStep("check", "active");
    this.setStatus("正在检查设备是否可以配置...", "info");

    wx.showLoading({ title: "检查中..." });
    let prepareResp = null;
    let prepareError = null;
    try {
      prepareResp = await callApi("device.prepareConfigure", { phone: this.data.phone, deviceNo: parsed.deviceNo });
    } catch (error) {
      prepareError = error;
      prepareResp = null;
    }
    wx.hideLoading();

    if (!this.handlePrepareResponse(prepareResp, prepareError)) {
      return;
    }

    this.setStep("check", "done");
    this.setStep("scan", "active");
    this.setStatus("请确认设备已进入配网模式，正在扫描 ytsh- 蓝牙设备...", "info");
    this.startBleDiscovery();
  },

  handlePrepareResponse(resp, requestError) {
    if (resp && resp.success) {
      this.setData({ prepareData: resp.data || null });
      return true;
    }

    const code = resp && resp.code;
    const requestUrl = getLastHttpRequestUrl();
    const errorMessage = requestError && (requestError.errMsg || requestError.message);
    const isDevCloudCheckBypass = apiConfig.allowDevProvisionWithoutCloudCheck
      && this.data.sessionDevBypass
      && !code;
    if (isDevCloudCheckBypass) {
      const detail = errorMessage ? `网络检查失败：${errorMessage}` : "云端检查暂时不可用";
      this.setData({
        prepareData: {
          deviceNo: this.data.parsedDevice.deviceNo,
          type: this.data.parsedDevice.deviceType.value,
          typeLabel: this.data.parsedDevice.deviceType.label,
          devBypass: true,
        },
      });
      this.setStatus(`${detail}，已按调试模式继续 BLE 配网。${requestUrl ? `请求地址：${requestUrl}` : ""}`, "info");
      return true;
    }

    const message = (resp && resp.message) || (errorMessage ? `网络请求失败：${errorMessage}` : "设备暂时无法配置");
    if (code === "DEVICE_ALREADY_BOUND") {
      this.setStep("check", "error");
      this.setStatus(DEVICE_ALREADY_BOUND_ERROR, "error");
      wx.showModal({ title: "无法配置", content: DEVICE_ALREADY_BOUND_ERROR, showCancel: false });
      return false;
    }
    if (code === "DEVICE_ALREADY_OWNED") {
      this.setStep("check", "done");
      this.setStatus(DEVICE_ALREADY_OWNED_ERROR, "info");
      wx.showModal({ title: "设备已存在", content: DEVICE_ALREADY_OWNED_ERROR, showCancel: false });
      return false;
    }
    if (code === "DEVICE_NOT_BINDABLE") {
      this.setStep("check", "error");
      this.setStatus(DEVICE_NO_ERROR, "error");
      wx.showToast({ title: DEVICE_NO_ERROR, icon: "none" });
      return false;
    }

    this.setStep("check", "error");
    const detailMessage = `${message}${requestUrl ? `\n请求地址：${requestUrl}` : ""}`;
    this.setStatus(detailMessage, "error");
    if (requestError) {
      wx.showModal({ title: "配置检查失败", content: detailMessage, showCancel: false });
    } else {
      wx.showToast({ title: message, icon: "none" });
    }
    return false;
  },

  startBleDiscovery() {
    this.stopBleDiscovery();

    if (apiConfig.mode === "mock") {
      this.useMockBleDevices();
      return;
    }

    wx.openBluetoothAdapter({
      success: () => {
        wx.offBluetoothDeviceFound && wx.offBluetoothDeviceFound();
        wx.onBluetoothDeviceFound(this.handleBluetoothDeviceFound.bind(this));
        wx.startBluetoothDevicesDiscovery({
          allowDuplicatesKey: true,
          interval: 0,
          powerLevel: "high",
          success: () => {
            this.setStatus("正在扫描附近以 ytsh- 开头的设备...", "info");
            this.refreshKnownBleDevices();
            this.bleScanPollTimer = setInterval(() => this.refreshKnownBleDevices(), 2000);
            this.bleScanTimeoutTimer = setTimeout(() => {
              if (!this.data.bleDevices.length) {
                this.stopBleDiscovery();
                this.setStep("scan", "error");
                this.setStatus(getProvisionErrorMessage("BLE_SCAN_TIMEOUT"), "error");
              }
            }, 15000);
          },
          fail: () => {
            this.setStep("scan", "error");
            this.setStatus(getProvisionErrorMessage("BLE_NOT_AVAILABLE"), "error");
          },
        });
      },
      fail: () => {
        this.setStep("scan", "error");
        this.setStatus(getProvisionErrorMessage("BLE_NOT_AVAILABLE"), "error");
      },
    });
  },

  handleBluetoothDeviceFound(res) {
    const devices = res.devices || [];
    this.processBleDevices(devices);
  },

  refreshKnownBleDevices() {
    if (!wx.getBluetoothDevices) {
      return;
    }
    wx.getBluetoothDevices({
      success: (res) => this.processBleDevices(res.devices || []),
    });
  },

  processBleDevices(devices) {
    const deviceMap = {};
    const now = Date.now();
    let matchedCount = 0;

    this.data.bleDevices.forEach((item) => {
      if (this.isFreshBleDevice(item, now)) {
        deviceMap[item.deviceId] = item;
      }
    });

    devices.forEach((item) => {
      const info = getBleDeviceInfo(item);
      const rssi = getValidBleRssi(item);
      console.log("[BLE] device found", {
        deviceId: item.deviceId,
        name: item.name,
        localName: item.localName,
        advertisName: info.advertisName,
        nameSource: info.nameSource,
        advertisedDeviceNo: info.advertisedDeviceNo,
        RSSI: item.RSSI,
      });

      if (!isYtshBleName(info.name)) {
        return;
      }

      if (rssi === null) {
        console.log("[BLE] skip cached or invalid ytsh device", { deviceId: item.deviceId, RSSI: item.RSSI });
        return;
      }

      matchedCount += 1;
      deviceMap[item.deviceId] = {
        deviceId: item.deviceId,
        name: info.name,
        rawName: info.rawName,
        localName: info.localName,
        advertisName: info.advertisName,
        nameSource: info.nameSource,
        advertisedDeviceNo: info.advertisedDeviceNo,
        advertisedTypeCode: info.advertisedTypeCode,
        advertisedSerial: info.advertisedSerial,
        RSSI: rssi,
        lastSeenAt: now,
      };
    });

    const bleDevices = Object.keys(deviceMap)
      .map((key) => deviceMap[key])
      .filter((item) => this.isFreshBleDevice(item, now))
      .sort((left, right) => right.RSSI - left.RSSI);
    this.setData({ bleDevices, showBleDeviceDialog: bleDevices.length ? this.data.showBleDeviceDialog : false });

    if (matchedCount > 0 && !this.data.showBleDeviceDialog && !this.data.selectedBleDevice) {
      this.setStatus(`已发现 ${bleDevices.length} 个 ytsh 设备，请在弹窗中选择设备。`, "info");
      this.setData({ showBleDeviceDialog: true });
    }
  },

  useMockBleDevices() {
    const parsed = this.data.parsedDevice;
    this.setData({
      bleDevices: [
        { deviceId: "mock-ytsh-1", name: `ytsh-${parsed.typeCode.toLowerCase()}-${parsed.serial.toLowerCase()}`, RSSI: -42, lastSeenAt: Date.now() },
      ],
      showBleDeviceDialog: true,
    });
    this.setStatus("已发现模拟 BLE 设备，请在弹窗中选择继续配置。", "info");
  },

  stopBleDiscovery() {
    if (this.bleScanPollTimer) {
      clearInterval(this.bleScanPollTimer);
      this.bleScanPollTimer = null;
    }
    if (this.bleScanTimeoutTimer) {
      clearTimeout(this.bleScanTimeoutTimer);
      this.bleScanTimeoutTimer = null;
    }
    try {
      wx.stopBluetoothDevicesDiscovery({});
    } catch (error) {}
    try {
      wx.offBluetoothDeviceFound && wx.offBluetoothDeviceFound();
    } catch (error) {}
  },

  isFreshBleDevice(device, now) {
    if (apiConfig.mode === "mock") {
      return !!device;
    }
    const checkedAt = now || Date.now();
    const rssi = Number(device && device.RSSI);
    const lastSeenAt = Number(device && device.lastSeenAt);
    return !!device && Number.isFinite(rssi) && rssi < BLE_INVALID_RSSI && Number.isFinite(lastSeenAt) && checkedAt - lastSeenAt <= BLE_DEVICE_TTL_MS;
  },

  closeCurrentBleConnection() {
    const deviceId = this.connectedBleDeviceId || (this.data.selectedBleDevice && this.data.selectedBleDevice.deviceId);
    if (!deviceId || apiConfig.mode === "mock") {
      this.connectedBleDeviceId = null;
      return;
    }
    try {
      wx.closeBLEConnection({ deviceId });
    } catch (error) {}
    this.connectedBleDeviceId = null;
  },

  removeBleDevice(deviceId) {
    const bleDevices = this.data.bleDevices.filter((item) => item.deviceId !== deviceId);
    this.setData({
      bleDevices,
      selectedBleDevice: null,
      showBleDeviceDialog: bleDevices.length > 0,
    });
  },

  selectBleDevice(e) {
    const deviceId = e.currentTarget.dataset.id;
    const selectedBleDevice = this.data.bleDevices.find((item) => item.deviceId === deviceId);
    if (!selectedBleDevice) {
      return;
    }
    if (!this.isFreshBleDevice(selectedBleDevice)) {
      this.removeBleDevice(deviceId);
      this.setStep("scan", "active");
      this.setStatus(getProvisionErrorMessage("BLE_STALE_DEVICE"), "info");
      this.startBleDiscovery();
      return;
    }

    if (selectedBleDevice.advertisedDeviceNo && selectedBleDevice.advertisedDeviceNo !== this.data.parsedDevice.deviceNo) {
      this.setStep("scan", "error");
      this.setStatus(getProvisionErrorMessage("DEVICE_NO_MISMATCH"), "error");
      wx.showModal({
        title: "设备号不匹配",
        content: `当前输入设备号为 ${this.data.parsedDevice.deviceNo}，但蓝牙广播设备号为 ${selectedBleDevice.advertisedDeviceNo}，请重新选择或修改设备号。`,
        showCancel: false,
      });
      return;
    }

    this.setData({ selectedBleDevice, showBleDeviceDialog: false });
    this.connectBleDevice(selectedBleDevice);
  },

  closeBleDeviceDialog() {
    this.setData({ showBleDeviceDialog: false });
  },

  reopenBleDeviceDialog() {
    if (this.data.bleDevices.length) {
      this.setData({ showBleDeviceDialog: true });
    }
  },

  closeWifiDialog() {
    this.setData({ showWifiDialog: false });
  },

  connectBleDevice(device) {
    this.stopBleDiscovery();
    this.closeCurrentBleConnection();
    this.setStatus(`正在连接 ${device.name}...`, "info");

    if (apiConfig.mode === "mock") {
      this.setStep("scan", "done");
      this.showWifiStep();
      return;
    }

    wx.createBLEConnection({
      deviceId: device.deviceId,
      timeout: 10000,
      success: () => {
        this.connectedBleDeviceId = device.deviceId;
        this.setStep("scan", "done");
        this.setupBleStatusNotify(device.deviceId)
          .then(() => this.sendDeviceNoForVerify(device.deviceId))
          .catch(() => {
            this.setStep("scan", "error");
            this.setStatus(getProvisionErrorMessage("BLE_STATUS_NOTIFY_UNAVAILABLE"), "error");
          });
      },
      fail: () => {
        this.closeCurrentBleConnection();
        this.removeBleDevice(device.deviceId);
        this.setStep("scan", "active");
        this.setStatus("蓝牙连接失败，该设备广播可能已过期或设备已退出配网模式，正在重新扫描...", "info");
        this.startBleDiscovery();
      },
    });
  },

  sendDeviceNoForVerify(deviceId) {
    const payload = { type: "verifyDeviceNo", deviceNo: this.data.parsedDevice.deviceNo, ts: Date.now() };
    return this.writeBlePayload(deviceId, payload)
      .then(() => this.waitForBleDeviceVerified(DEFAULT_DEVICE_VERIFY_TIMEOUT_MS))
      .then(() => this.showWifiStep())
      .catch((error) => {
        this.setStep("scan", "error");
        const message = error && error.provisionMessage
          ? error.provisionMessage
          : getProvisionErrorMessage(error && error.code, getProvisionErrorMessage("DEVICE_VERIFY_FAILED"));
        this.setStatus(message, "error");
        wx.showModal({ title: "设备校验失败", content: message, showCancel: false });
      });
  },

  setupBleStatusNotify(deviceId) {
    if (!wx.notifyBLECharacteristicValueChange || !wx.onBLECharacteristicValueChange) {
      return Promise.reject(new Error("BLE notify is not available"));
    }
    this.cleanupBleStatusNotify();
    this.bleStatusDeviceId = deviceId;
    this.bleStatusTextBuffer = "";
    this.lastBleWifiStatusPayload = null;
    this.lastBleVerifyStatusPayload = null;
    this.bleStatusHandler = (res) => this.handleBleStatusNotify(res);
    wx.onBLECharacteristicValueChange(this.bleStatusHandler);

    return new Promise((resolve, reject) => {
      wx.notifyBLECharacteristicValueChange({
        deviceId,
        serviceId: PROVISION_SERVICE_UUID,
        characteristicId: PROVISION_NOTIFY_UUID,
        state: true,
        success: resolve,
        fail: reject,
      });
    });
  },

  cleanupBleStatusNotify() {
    if (this.bleWifiStatusTimer) {
      clearTimeout(this.bleWifiStatusTimer);
      this.bleWifiStatusTimer = null;
    }
    if (this.bleWifiStatusReject) {
      this.bleWifiStatusReject = null;
      this.bleWifiStatusResolve = null;
    }
    if (this.bleVerifyTimer) {
      clearTimeout(this.bleVerifyTimer);
      this.bleVerifyTimer = null;
    }
    if (this.bleVerifyReject) {
      this.bleVerifyReject = null;
      this.bleVerifyResolve = null;
    }
    if (this.bleStatusHandler && wx.offBLECharacteristicValueChange) {
      try {
        wx.offBLECharacteristicValueChange(this.bleStatusHandler);
      } catch (error) {}
    }
    this.bleStatusHandler = null;
    this.bleStatusTextBuffer = "";
  },

  handleBleStatusNotify(res) {
    if (this.bleStatusDeviceId && res.deviceId && res.deviceId !== this.bleStatusDeviceId) {
      return;
    }
    if (res.characteristicId && normalizeUuid(res.characteristicId) !== normalizeUuid(PROVISION_NOTIFY_UUID)) {
      return;
    }
    const text = bufferToUtf8Text(res.value);
    if (!text) {
      return;
    }
    this.bleStatusTextBuffer = `${this.bleStatusTextBuffer || ""}${text}`;
    const parts = this.bleStatusTextBuffer.split("\n");
    this.bleStatusTextBuffer = parts.pop() || "";
    parts.forEach((part) => this.handleBleStatusLine(part));

    const buffered = (this.bleStatusTextBuffer || "").trim();
    if (buffered[0] === "{" && buffered[buffered.length - 1] === "}") {
      this.bleStatusTextBuffer = "";
      this.handleBleStatusLine(buffered);
    }
  },

  handleBleStatusLine(line) {
    const text = String(line || "").trim();
    if (!text) {
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      return;
    }

    if (getBleVerifyStatusType(payload)) {
      this.handleBleVerifyStatusPayload(payload);
      return;
    }

    if (!getBleWifiStatusType(payload)) {
      return;
    }
    this.lastBleWifiStatusPayload = payload;
    const status = normalizeBleWifiStatus(payload);
    if (status === "progress") {
      this.setStatus(getBleWifiStatusMessage(payload), "info");
      return;
    }
    if (status === "connected") {
      if (this.bleWifiStatusResolve) {
        const resolve = this.bleWifiStatusResolve;
        this.clearBleWifiWaiter();
        resolve(payload);
      }
      return;
    }
    if (status === "failed") {
      const error = new Error(getBleWifiStatusError(payload));
      error.code = normalizeProvisionErrorCode(payload.code || "WIFI_FAILED");
      error.provisionMessage = getBleWifiStatusError(payload);
      if (this.bleWifiStatusReject) {
        const reject = this.bleWifiStatusReject;
        this.clearBleWifiWaiter();
        reject(error);
      }
    }
  },

  handleBleVerifyStatusPayload(payload) {
    this.lastBleVerifyStatusPayload = payload;
    const status = normalizeBleVerifyStatus(payload);
    if (status === "verified") {
      if (this.bleVerifyResolve) {
        const resolve = this.bleVerifyResolve;
        this.clearBleVerifyWaiter();
        resolve(payload);
      }
      return;
    }
    if (status === "failed") {
      const error = new Error(getBleVerifyStatusError(payload));
      error.code = normalizeProvisionErrorCode(payload.code || "DEVICE_VERIFY_FAILED");
      error.provisionMessage = getBleVerifyStatusError(payload);
      if (this.bleVerifyReject) {
        const reject = this.bleVerifyReject;
        this.clearBleVerifyWaiter();
        reject(error);
      }
    }
  },

  clearBleWifiWaiter() {
    if (this.bleWifiStatusTimer) {
      clearTimeout(this.bleWifiStatusTimer);
      this.bleWifiStatusTimer = null;
    }
    this.bleWifiStatusResolve = null;
    this.bleWifiStatusReject = null;
  },

  clearBleVerifyWaiter() {
    if (this.bleVerifyTimer) {
      clearTimeout(this.bleVerifyTimer);
      this.bleVerifyTimer = null;
    }
    this.bleVerifyResolve = null;
    this.bleVerifyReject = null;
  },

  waitForBleDeviceVerified(timeoutMs) {
    const lastPayload = this.lastBleVerifyStatusPayload;
    const lastStatus = normalizeBleVerifyStatus(lastPayload);
    if (lastStatus === "verified") {
      return Promise.resolve(lastPayload);
    }
    if (lastStatus === "failed") {
      const error = new Error(getBleVerifyStatusError(lastPayload));
      error.code = normalizeProvisionErrorCode(lastPayload.code || "DEVICE_VERIFY_FAILED");
      error.provisionMessage = getBleVerifyStatusError(lastPayload);
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      this.clearBleVerifyWaiter();
      this.bleVerifyResolve = resolve;
      this.bleVerifyReject = reject;
      this.bleVerifyTimer = setTimeout(() => {
        this.clearBleVerifyWaiter();
        resolve({ type: "verifyDeviceNo.status", status: "unknown", code: "VERIFY_NO_RESPONSE" });
      }, timeoutMs);
    });
  },

  waitForBleWifiConnected(timeoutMs) {
    const lastPayload = this.lastBleWifiStatusPayload;
    const lastStatus = normalizeBleWifiStatus(lastPayload);
    if (lastStatus === "connected") {
      return Promise.resolve(lastPayload);
    }
    if (lastStatus === "failed") {
      const error = new Error(getBleWifiStatusError(lastPayload));
      error.code = normalizeProvisionErrorCode(lastPayload.code || "WIFI_FAILED");
      error.provisionMessage = getBleWifiStatusError(lastPayload);
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      this.clearBleWifiWaiter();
      this.bleWifiStatusResolve = resolve;
      this.bleWifiStatusReject = reject;
      this.bleWifiStatusTimer = setTimeout(() => {
        const error = new Error(getProvisionErrorMessage("BLE_WIFI_STATUS_TIMEOUT"));
        error.code = "BLE_WIFI_STATUS_TIMEOUT";
        error.provisionMessage = getProvisionErrorMessage("BLE_WIFI_STATUS_TIMEOUT");
        this.clearBleWifiWaiter();
        reject(error);
      }, timeoutMs);
    });
  },

  showWifiStep() {
    this.setStep("wifi", "active");
    this.setData({
      showWifiDialog: true,
      wifiPasswordVisible: false,
      wifiManualMode: false,
      wifiManualSsid: "",
    });
    this.loadWifiInfo();
  },

  loadWifiInfo() {
    this.setStatus("请确认手机当前连接的 Wi‑Fi，并输入 Wi‑Fi 密码。", "info");
    if (!wx.getConnectedWifi) {
      this.setData({ wifiSsid: "" });
      this.setStatus(getProvisionErrorMessage("WIFI_NOT_CONNECTED"), "info");
      return;
    }

    wx.startWifi({
      success: () => {
        wx.getConnectedWifi({
          success: (res) => {
            const wifi = res.wifi || {};
            const wifiSsid = wifi.SSID || "";
            this.setData({ wifiSsid });
            if (!wifiSsid) {
              this.setStatus(getProvisionErrorMessage("WIFI_NOT_CONNECTED"), "info");
            }
          },
          fail: () => {
            this.setData({ wifiSsid: "" });
            this.setStatus(getProvisionErrorMessage("WIFI_NOT_CONNECTED"), "info");
          },
        });
      },
      fail: () => {
        this.setData({ wifiSsid: "" });
        this.setStatus(getProvisionErrorMessage("WIFI_NOT_CONNECTED"), "info");
      },
    });
  },

  async sendWifiToDevice() {
    const ssid = this.getEffectiveWifiSsid() || (apiConfig.mode === "mock" ? "Mock-WiFi" : "");
    if (!ssid && apiConfig.mode !== "mock") {
      this.setStatus(getProvisionErrorMessage(this.data.wifiManualMode ? "WIFI_SSID_REQUIRED" : "WIFI_NOT_CONNECTED"), "error");
      return;
    }
    if (!this.data.wifiPassword) {
      this.setStatus(getProvisionErrorMessage("WIFI_PASSWORD_REQUIRED"), "error");
      return;
    }

    const prepareData = this.data.prepareData || {};
    if (!prepareData.provisionSessionId) {
      this.setStatus("缺少配网会话，请返回重新开始配置。", "error");
      return;
    }
    const payload = {
      type: "provisionWifi",
      deviceNo: this.data.parsedDevice.deviceNo,
      provisionSessionId: prepareData.provisionSessionId,
      apiUrl: `${apiConfig.baseUrl}${apiConfig.httpPath || "/api"}`,
      secureProtocol: "YTS-SEC/1-AES-128-CCM",
      heartbeatIntervalMs: getHeartbeatIntervalMs(prepareData),
      statusNotify: {
        serviceUuid: PROVISION_SERVICE_UUID,
        characteristicUuid: PROVISION_NOTIFY_UUID,
        format: "json-lines",
      },
      ssid,
      password: this.data.wifiPassword,
      ts: Date.now(),
    };

    this.setStatus("正在通过 BLE 发送 Wi‑Fi 信息...", "info");
    this.setStep("wifi", "active");

    if (apiConfig.mode === "mock") {
      await this.completeMockProvision();
      return;
    }

    const device = this.data.selectedBleDevice;
    if (!device) {
      this.setStatus(getProvisionErrorMessage("BLE_CONNECT_FAILED"), "error");
      return;
    }

    try {
      await this.writeBlePayload(device.deviceId, payload);
      this.setData({ showWifiDialog: false });
      this.setStatus("Wi‑Fi 信息已发送，正在等待设备返回连接结果...", "info");
      await this.waitForBleWifiConnected(getWifiStatusTimeoutMs(prepareData));
      this.setStep("wifi", "done");
      this.setStatus("设备已连接 Wi‑Fi，正在等待云端认证...", "info");
      this.waitCloudOnline();
    } catch (error) {
      this.setStep("wifi", "error");
      const message = error && error.provisionMessage
        ? error.provisionMessage
        : getProvisionErrorMessage(error && error.code, getProvisionErrorMessage("WIFI_CONNECT_TIMEOUT"));
      this.setStatus(message, "error");
      wx.showModal({ title: "配网失败", content: message, showCancel: false });
    }
  },

  async writeBlePayload(deviceId, payload) {
    const chunks = encodePayloadChunks(payload);
    for (let index = 0; index < chunks.length; index += 1) {
      await new Promise((resolve, reject) => {
        wx.writeBLECharacteristicValue({
          deviceId,
          serviceId: PROVISION_SERVICE_UUID,
          characteristicId: PROVISION_WRITE_UUID,
          value: chunks[index],
          success: resolve,
          fail: reject,
        });
      });
      await delay(30);
    }
  },

  async completeMockProvision() {
    this.setData({ showWifiDialog: false });
    this.setStep("wifi", "done");
    this.setStep("cloud", "active");
    this.setStatus("模拟设备正在连接 Wi‑Fi 和云端...", "info");
    await delay(800);
    await this.waitCloudOnline();
  },

  async waitCloudOnline() {
    this.setStep("cloud", "active");
    this.setStatus("正在等待设备连接云端并完成认证...", "info");

    const prepareData = this.data.prepareData || {};
    const provisionSessionId = prepareData.provisionSessionId || "";
    if (!provisionSessionId) {
      this.setStep("cloud", "error");
      this.setStatus(getProvisionErrorMessage("PROVISION_SESSION_NOT_FOUND"), "error");
      return;
    }

    const startedAt = Date.now();
    const timeoutMs = Number(prepareData.timeoutMs) || DEFAULT_PROVISION_TIMEOUT_MS;
    const pollIntervalMs = Number(prepareData.pollIntervalMs) || DEFAULT_PROVISION_POLL_INTERVAL_MS;
    let lastResp = null;

    while (Date.now() - startedAt < timeoutMs) {
      try {
        lastResp = await callApi("device.checkProvisionStatus", {
          phone: this.data.phone,
          deviceNo: this.data.parsedDevice.deviceNo,
          provisionSessionId,
        });
      } catch (error) {
        lastResp = null;
      }

      if (lastResp && lastResp.success && lastResp.code === "DEVICE_READY_TO_BIND") {
        this.setStep("cloud", "done");
        this.setStatus("设备已上线并通过云端认证，正在完成绑定...", "info");
        await this.finalBind();
        return;
      }

      if (lastResp && !lastResp.success) {
        const code = lastResp.code || "DEVICE_PROVISION_TIMEOUT";
        this.setStep("cloud", "error");
        this.setStatus(getProvisionErrorMessage(code, lastResp.message), "error");
        wx.showModal({ title: "设备未上线", content: getProvisionErrorMessage(code, lastResp.message), showCancel: false });
        return;
      }

      this.setStatus("正在等待设备上线，请保持设备和路由器通电联网...", "info");
      await delay(pollIntervalMs);
    }

    this.setStep("cloud", "error");
    const message = getProvisionErrorMessage("DEVICE_PROVISION_TIMEOUT", lastResp && lastResp.message);
    this.setStatus(message, "error");
    wx.showModal({ title: "设备未上线", content: message, showCancel: false });
  },

  async finalBind() {
    this.setStep("bind", "active");
    this.setStatus("设备已连接云端，正在完成绑定...", "info");
    wx.showLoading({ title: "绑定中..." });
    const prepareData = this.data.prepareData || {};
    let bindResp = null;
    try {
      bindResp = await callApi("device.bind", {
        phone: this.data.phone,
        deviceNo: this.data.parsedDevice.deviceNo,
        deviceName: this.data.deviceName,
        provisionSessionId: prepareData.provisionSessionId || "",
      });
    } catch (error) {
      bindResp = null;
    }
    wx.hideLoading();

    if (!bindResp || !bindResp.success || !bindResp.data || !bindResp.data.device) {
      const message = (bindResp && bindResp.message) || "绑定失败，请稍后重试";
      this.setStep("bind", "error");
      this.setStatus(message, "error");
      wx.showModal({ title: "绑定失败", content: message, showCancel: false });
      return;
    }

    const devices = getStoredDevices(this.data.phone).filter((item) => item.deviceNo !== this.data.parsedDevice.deviceNo);
    const device = createDeviceFromRemote(this.data.parsedDevice, this.data.deviceName, bindResp.data.device);
    device.ownerPhone = this.data.phone;
    devices.unshift(device);
    setStoredDevices(this.data.phone, devices);

    this.setStep("bind", "done");
    this.setStatus("配置成功，设备已加入我的设备。", "success");
    wx.showModal({
      title: "配置成功",
      content: "设备已成功连接云端并加入我的设备。",
      showCancel: false,
      success: () => {
        wx.navigateBack({ delta: 1 });
      },
    });
  },

  setStatus(statusMessage, statusType) {
    this.setData({ statusMessage, statusType });
  },

  resetSteps() {
    this.setData({ steps: this.data.steps.map((item) => ({ ...item, status: "pending" })) });
  },

  setStep(key, status) {
    this.setData({
      steps: this.data.steps.map((item) => (item.key === key ? { ...item, status } : item)),
    });
  },
});
