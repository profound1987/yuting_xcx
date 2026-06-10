const MOCK_REGISTRY_KEY = "yuntingMockDeviceRegistryV2";
const MOCK_USERS_KEY = "yuntingMockUsersV1";
const MOCK_BIND_ATTEMPTS_KEY = "yuntingMockBindAttemptsV1";
const MOCK_PROVISION_SESSIONS_KEY = "yuntingMockProvisionSessionsV1";
const DEVICE_CODE_SALT = "YUNTING-ZHIJIA-DEVICE-CODE-V1";
const DEVICE_NO_PATTERN = /^YT-([A-Z]{2})-([0-9A-F]{5})-([0-9A-F]{4})$/;
const BIND_FAILURE_WARNING_THRESHOLD = 3;
const BIND_FAILURE_LOCK_THRESHOLD = 10;
const BIND_FAILURE_LOCK_HOURS = 24;
const BIND_FAILURE_WINDOW_MS = BIND_FAILURE_LOCK_HOURS * 60 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 90000;

const DEVICE_TYPES = [
  { label: "智能浇水设备", value: "watering", code: "AW" },
  { label: "环境传感器", value: "sensor", code: "ES" },
  { label: "智能灯控", value: "light", code: "LC" },
  { label: "智能插座", value: "socket", code: "SP" },
  { label: "智能网关", value: "gateway", code: "GW" },
];

const CRC32_TABLE = createCrc32Table();

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

function isRecordProvisioned(record) {
  return (record.provisionState || "provisioned") === "provisioned";
}

function getNetworkState(record) {
  if (!isRecordProvisioned(record)) {
    return "not_provisioned";
  }
  return record.online ? "online" : "offline";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function maskPhone(phone) {
  return String(phone || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function getDeviceTypeByCode(code) {
  return DEVICE_TYPES.find((item) => item.code === code);
}

function normalizeDeviceNo(value) {
  return (value || "").trim().toUpperCase();
}

function parseDeviceNo(value) {
  const deviceNo = normalizeDeviceNo(value);
  const matched = deviceNo.match(DEVICE_NO_PATTERN);
  if (!matched) {
    return null;
  }

  const typeCode = matched[1];
  const serial = matched[2];
  const checkCode = matched[3];
  const body = `YT-${typeCode}-${serial}`;
  const deviceType = getDeviceTypeByCode(typeCode);
  if (!deviceType || getCheckCode(body) !== checkCode) {
    return null;
  }

  return {
    deviceNo,
    typeCode,
    serial,
    serialNumber: parseInt(serial, 16),
    deviceType,
  };
}

function createWateringConfig() {
  return {};
}

function createWateringCapabilities() {
  return {
    schemaVersion: 1,
    model: "YT-AW-BASIC-SM",
    hwVersion: "mock",
    fwVersion: "mock",
    components: {
      waterPump: { present: true, channels: 1, feedback: "none" },
      soilMoistureSensor: { present: true, valueType: "percent", range: { min: 0, max: 100 }, calibratable: true },
      waterLevelSensor: { present: false },
      rtc: { present: false },
      localStorage: { present: true, persistentConfig: true },
    },
    features: {
      manualWatering: {
        supported: true,
        label: "手动浇水",
        commands: ["watering.manual.start", "watering.manual.stop"],
        params: {
          durationSeconds: { type: "integer", unit: "s", required: true, min: 1, max: 3600, recommended: 10, default: null },
        },
      },
      scheduleWatering: {
        supported: true,
        label: "定期浇水",
        requires: ["waterPump", "localStorage"],
        params: {
          intervalDays: { type: "integer", unit: "day", required: true, min: 1, max: 365, recommended: 1, default: null },
          timesPerDay: { type: "integer", unit: "count", required: true, min: 1, max: 24, recommended: 2, default: null },
          durationSeconds: { type: "integer", unit: "s", required: true, min: 1, max: 3600, recommended: 30, default: null },
        },
      },
      demandWatering: {
        supported: true,
        label: "按需浇水",
        requires: ["waterPump", "soilMoistureSensor", "localStorage"],
        params: {
          checkIntervalHours: { type: "integer", unit: "hour", required: true, min: 1, max: 72, recommended: 4, default: null },
          thresholdPercent: { type: "integer", unit: "%", required: true, min: 1, max: 100, recommended: 35, default: null },
          durationSeconds: { type: "integer", unit: "s", required: true, min: 1, max: 3600, recommended: 20, default: null },
        },
      },
      waterTankProtection: { supported: false, label: "缺水保护", requires: ["waterLevelSensor"] },
    },
  };
}

function createGenericCapabilities() {
  return { schemaVersion: 1, components: {}, features: {} };
}

function defaultCapabilitiesForType(type) {
  return type === "watering" ? createWateringCapabilities() : createGenericCapabilities();
}

function emptyConfigState() {
  return {
    config: {},
    configState: "unconfigured",
    desiredConfig: null,
    desiredConfigVersion: 0,
    desiredConfigHash: "",
    appliedConfig: null,
    appliedConfigVersion: 0,
    appliedConfigHash: "",
    pendingCommandId: "",
  };
}

function ensureRecordShape(record) {
  if (!record) {
    return record;
  }
  if (!record.provisionState) {
    record.provisionState = "provisioned";
  }
  if (!record.capabilities) {
    record.capabilities = defaultCapabilitiesForType(record.type);
  }
  if (!record.capabilityState) {
    record.capabilityState = "reported";
  }
  if (!record.configState) {
    Object.assign(record, emptyConfigState());
  }
  if (record.type === "watering" && record.configState === "unconfigured") {
    record.config = {};
    record.desiredConfig = null;
    record.appliedConfig = null;
  }
  return record;
}

function getScenario(serialNumber) {
  if (serialNumber >= 0x00000 && serialNumber <= 0x00031) {
    return "sale-unbound-online";
  }
  if (serialNumber >= 0x00032 && serialNumber <= 0x0004a) {
    return "sale-bound-online";
  }
  if (serialNumber >= 0x0004b && serialNumber <= 0x00063) {
    return "sale-bound-offline";
  }
  return "not-produced";
}

function createDeviceNo(typeCode, serial) {
  const body = `YT-${typeCode}-${serial}`;
  return `${body}-${getCheckCode(body)}`;
}

function createMockRecord(typeInfo, serialNumber) {
  const serial = serialNumber.toString(16).toUpperCase().padStart(5, "0");
  const scenario = getScenario(serialNumber);
  const deviceNo = createDeviceNo(typeInfo.code, serial);
  const online = scenario !== "sale-bound-offline";
  const bindStatus = scenario === "sale-unbound-online" ? "unbound" : "bound";
  const ownerPhone = scenario === "sale-bound-online" ? "mock-other-user" : null;
  const now = Date.now();

  return {
    id: `mock_${deviceNo.replace(/-/g, "_")}`,
    deviceNo,
    typeCode: typeInfo.code,
    serial,
    type: typeInfo.value,
    typeLabel: typeInfo.label,
    name: typeInfo.label,
    status: "registered",
    bindStatus,
    provisionState: "provisioned",
    ownerPhone,
    mockScenario: scenario,
    online,
    displayStatus: online ? "在线" : "离线",
    config: {},
    configState: "unconfigured",
    desiredConfig: null,
    desiredConfigVersion: 0,
    desiredConfigHash: "",
    appliedConfig: null,
    appliedConfigVersion: 0,
    appliedConfigHash: "",
    pendingCommandId: "",
    capabilityState: "reported",
    capabilities: defaultCapabilitiesForType(typeInfo.value),
    lastWateringAt: "--",
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createInitialRegistry() {
  const registry = {};
  DEVICE_TYPES.forEach((typeInfo) => {
    for (let serialNumber = 0; serialNumber <= 0x00063; serialNumber += 1) {
      const record = createMockRecord(typeInfo, serialNumber);
      registry[record.deviceNo] = record;
    }
  });
  return registry;
}

function getRegistry() {
  const registry = wx.getStorageSync(MOCK_REGISTRY_KEY);
  if (registry && Object.keys(registry).length > 0) {
    let changed = false;
    Object.keys(registry).forEach((key) => {
      const before = JSON.stringify(registry[key]);
      ensureRecordShape(registry[key]);
      if (JSON.stringify(registry[key]) !== before) {
        changed = true;
      }
    });
    if (changed) {
      wx.setStorageSync(MOCK_REGISTRY_KEY, registry);
    }
    return registry;
  }

  const initialRegistry = createInitialRegistry();
  wx.setStorageSync(MOCK_REGISTRY_KEY, initialRegistry);
  return initialRegistry;
}

function setRegistry(registry) {
  wx.setStorageSync(MOCK_REGISTRY_KEY, registry);
}

function getUsers() {
  return wx.getStorageSync(MOCK_USERS_KEY) || {};
}

function setUsers(users) {
  wx.setStorageSync(MOCK_USERS_KEY, users);
}

function getBindAttempts() {
  return wx.getStorageSync(MOCK_BIND_ATTEMPTS_KEY) || [];
}

function getProvisionSessions() {
  return wx.getStorageSync(MOCK_PROVISION_SESSIONS_KEY) || {};
}

function setProvisionSessions(sessions) {
  wx.setStorageSync(MOCK_PROVISION_SESSIONS_KEY, sessions);
}

function setBindAttempts(attempts) {
  const windowStart = Date.now() - BIND_FAILURE_WINDOW_MS;
  wx.setStorageSync(MOCK_BIND_ATTEMPTS_KEY, attempts.filter((item) => item.createdAt >= windowStart));
}

function getBindFailureSummary(phone) {
  const now = Date.now();
  const windowStart = now - BIND_FAILURE_WINDOW_MS;
  const failures = getBindAttempts()
    .filter((item) => item.phone === phone && item.result === "failed" && item.createdAt >= windowStart)
    .sort((left, right) => right.createdAt - left.createdAt);
  const failedCount = failures.length;
  const lockedUntil = failedCount >= BIND_FAILURE_LOCK_THRESHOLD
    ? failures.slice(0, BIND_FAILURE_LOCK_THRESHOLD).reduce((oldest, item) => Math.min(oldest, item.createdAt), failures[0].createdAt) + BIND_FAILURE_WINDOW_MS
    : null;
  return {
    failedCount24h: failedCount,
    warningThreshold: BIND_FAILURE_WARNING_THRESHOLD,
    lockThreshold: BIND_FAILURE_LOCK_THRESHOLD,
    remainingBeforeLock: Math.max(0, BIND_FAILURE_LOCK_THRESHOLD - failedCount),
    lockHours: BIND_FAILURE_LOCK_HOURS,
    locked: !!(lockedUntil && now < lockedUntil),
    lockedUntil,
    lockedUntilText: lockedUntil ? formatTime(new Date(lockedUntil)) : "",
  };
}

function recordBindAttempt(phone, inputDeviceNo, normalizedDeviceNo, result, code, message, reason) {
  if (!phone) {
    return;
  }
  const attempts = getBindAttempts();
  attempts.push({
    id: `mock_bind_attempt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    phone,
    inputDeviceNo: inputDeviceNo || "",
    normalizedDeviceNo: normalizedDeviceNo || "",
    result,
    code,
    message,
    reason,
    createdAt: Date.now(),
  });
  setBindAttempts(attempts);
}

function bindRiskMessage(message, summary) {
  if (summary.failedCount24h >= BIND_FAILURE_LOCK_THRESHOLD) {
    return `${message}。当前手机号24小时内绑定失败已达到${BIND_FAILURE_LOCK_THRESHOLD}次，${BIND_FAILURE_LOCK_HOURS}小时内将无法再次绑定。`;
  }
  if (summary.failedCount24h > BIND_FAILURE_WARNING_THRESHOLD) {
    return `${message}。当前手机号24小时内绑定失败已达到${summary.failedCount24h}次，超过${BIND_FAILURE_LOCK_THRESHOLD}次将锁定${BIND_FAILURE_LOCK_HOURS}小时。`;
  }
  return message;
}

function ensureUser(phone) {
  if (!phone) {
    return null;
  }

  const users = getUsers();
  if (users[phone]) {
    return users[phone];
  }

  const now = Date.now();
  const user = {
    id: `mock_user_${phone}`,
    phone,
    phoneMasked: maskPhone(phone),
    status: "active",
    wechatBindings: [],
    createdAt: now,
    updatedAt: now,
  };
  users[phone] = user;
  setUsers(users);
  return user;
}

function normalizeUser(user) {
  if (!user) {
    return null;
  }
  if (!user.phoneMasked) {
    user.phoneMasked = maskPhone(user.phone);
  }
  if (!Array.isArray(user.wechatBindings)) {
    user.wechatBindings = [];
  }
  return user;
}

function getRecord(deviceNo) {
  const parsed = parseDeviceNo(deviceNo);
  if (!parsed || parsed.serialNumber > 0x00063) {
    return { registry: getRegistry(), record: null };
  }

  const registry = getRegistry();
  return { registry, record: registry[parsed.deviceNo] || null };
}

function getDisplayStatus(record) {
  if (!isRecordProvisioned(record)) {
    return "未入网";
  }
  if (record.displayStatus === "浇水中") {
    return "浇水中";
  }
  return record.online ? "在线" : "离线";
}

function createDevicePayload(record, name) {
  ensureRecordShape(record);
  return {
    id: record.id,
    deviceNo: record.deviceNo,
    deviceSerial: record.serial,
    deviceTypeCode: record.typeCode,
    name: name || record.name,
    type: record.type,
    typeLabel: record.typeLabel,
    status: getDisplayStatus(record),
    online: record.online && isRecordProvisioned(record),
    bindStatus: record.bindStatus,
    provisionState: record.provisionState || "provisioned",
    provisioned: isRecordProvisioned(record),
    networkState: getNetworkState(record),
    canConfigure: record.bindStatus === "bound" && !isRecordProvisioned(record),
    canBleControl: record.bindStatus === "bound" && (!isRecordProvisioned(record) || !record.online),
    ownerPhone: record.ownerPhone,
    mockScenario: record.mockScenario,
    config: clone(record.config || {}),
    configState: record.configState || "unconfigured",
    desiredConfig: record.desiredConfig ? clone(record.desiredConfig) : null,
    desiredConfigVersion: record.desiredConfigVersion || 0,
    appliedConfig: record.appliedConfig ? clone(record.appliedConfig) : null,
    appliedConfigVersion: record.appliedConfigVersion || 0,
    pendingCommandId: record.pendingCommandId || "",
    capabilityState: record.capabilityState || "reported",
    capabilities: clone(record.capabilities || defaultCapabilitiesForType(record.type)),
    lastWateringAt: record.lastWateringAt || "--",
    lastSyncedAt: record.lastSyncedAt,
    heartbeatIntervalMs: record.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: (record.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS) * 2,
    lastHeartbeatAt: record.lastHeartbeatAt || null,
    lastBootAt: record.lastBootAt || null,
    lastSeenAt: record.lastSeenAt || (record.online ? record.updatedAt : null),
    telemetry: clone(record.telemetry || {}),
    syncState: isRecordProvisioned(record) ? (record.online ? "synced" : "offline") : "not_provisioned",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function success(data) {
  return Promise.resolve({
    success: true,
    code: "OK",
    message: "",
    data,
  });
}

function commandAccepted(data, message = "命令已接受") {
  return Promise.resolve({
    success: true,
    code: "COMMAND_ACCEPTED",
    message,
    data,
  });
}

function failure(code, message, data = null) {
  return Promise.resolve({
    success: false,
    code,
    message,
    data,
  });
}

function bindFailure(phone, inputDeviceNo, normalizedDeviceNo, code, message, reason) {
  recordBindAttempt(phone, inputDeviceNo, normalizedDeviceNo, "failed", code, message, reason);
  if (!phone) {
    return failure(code, message);
  }
  const summary = getBindFailureSummary(phone);
  return failure(code, bindRiskMessage(message, summary), { bindRisk: summary });
}

function bindLockedFailure(phone, inputDeviceNo, normalizedDeviceNo) {
  if (!phone) {
    return null;
  }
  const summary = getBindFailureSummary(phone);
  if (!summary.locked) {
    return null;
  }
  const message = `绑定失败次数过多，请在${summary.lockedUntilText}后再试`;
  recordBindAttempt(phone, inputDeviceNo, normalizedDeviceNo, "blocked", "DEVICE_BIND_LOCKED", message, "too_many_bind_failures");
  return failure("DEVICE_BIND_LOCKED", message, { bindRisk: summary });
}

function checkBindable(data) {
  const { record } = getRecord(data.deviceNo);
  const bindable = !!(record && record.status === "registered" && record.bindStatus === "unbound" && record.online);
  return success({ bindable });
}

function prepareConfigure(data) {
  const phone = data.phone || "";
  const inputDeviceNo = data.deviceNo || "";
  const normalizedDeviceNo = normalizeDeviceNo(inputDeviceNo);
  const locked = bindLockedFailure(phone, inputDeviceNo, normalizedDeviceNo);
  if (locked) {
    return locked;
  }

  const { record } = getRecord(data.deviceNo);
  if (!record || record.status !== "registered") {
    return bindFailure(phone, inputDeviceNo, normalizedDeviceNo, "DEVICE_NOT_BINDABLE", "设备号不正确", "prepare_not_registered");
  }

  const user = ensureUser(phone);
  if (!user) {
    return failure("USER_REQUIRED", "请先登录");
  }

  if (record.bindStatus === "bound" && record.ownerPhone === phone && isRecordProvisioned(record)) {
    return failure("DEVICE_ALREADY_OWNED", "该设备已经是你的设备", { device: createDevicePayload(record, record.name) });
  }

  if ((record.bindStatus === "bound" && record.ownerPhone && record.ownerPhone !== phone) || record.mockScenario === "sale-bound-online") {
    return bindFailure(phone, inputDeviceNo, record.deviceNo, "DEVICE_ALREADY_BOUND", "设备已被绑定，请联系管理员解绑", "prepare_bound_by_other");
  }

  const sessions = getProvisionSessions();
  const now = Date.now();
  const provisionSessionId = `mock_ps_${now}_${Math.random().toString(16).slice(2)}`;
  sessions[provisionSessionId] = {
    id: provisionSessionId,
    deviceNo: record.deviceNo,
    phone,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 10 * 60 * 1000,
    lastOnlineAt: null,
  };
  setProvisionSessions(sessions);

  return success({
    deviceNo: record.deviceNo,
    deviceSerial: record.serial,
    deviceTypeCode: record.typeCode,
    type: record.type,
    typeLabel: record.typeLabel,
    bindStatus: record.bindStatus,
    provisionState: record.provisionState || "provisioned",
    pinRequired: false,
    bleNamePrefix: "ytsh-",
    needBleProvision: true,
    provisionSessionId,
    expiresAt: sessions[provisionSessionId].expiresAt,
    pollIntervalMs: 500,
    timeoutMs: 10000,
    heartbeatIntervalMs: record.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS,
    wifiStatusTimeoutMs: 60000,
  });
}

function listDevices(data) {
  const phone = data.phone || "";
  const registry = getRegistry();
  const devices = Object.keys(registry)
    .map((key) => registry[key])
    .filter((record) => record.ownerPhone === phone && record.bindStatus === "bound")
    .map((record) => createDevicePayload(record, record.name));
  return success({ devices });
}

function checkProvisionStatus(data) {
  const phone = data.phone || "";
  const sessions = getProvisionSessions();
  const session = sessions[data.provisionSessionId];
  if (!session || session.deviceNo !== normalizeDeviceNo(data.deviceNo) || session.phone !== phone) {
    return failure("PROVISION_SESSION_NOT_FOUND", "请重新配置设备", {
      online: false,
      readyToBind: false,
      provisionStatus: "not_found",
    });
  }

  const now = Date.now();
  if (now >= session.expiresAt) {
    session.status = "expired";
    session.updatedAt = now;
    sessions[session.id] = session;
    setProvisionSessions(sessions);
    return failure("DEVICE_PROVISION_TIMEOUT", "设备未上线，请检查网络是否正常", {
      online: false,
      readyToBind: false,
      provisionStatus: "expired",
    });
  }

  if (session.status === "pending") {
    session.status = "ready_to_bind";
    session.updatedAt = now;
    session.lastOnlineAt = now;
    sessions[session.id] = session;
    setProvisionSessions(sessions);
  }

  return Promise.resolve({
    success: true,
    code: "DEVICE_READY_TO_BIND",
    message: "设备已上线，可以绑定",
    data: {
      provisionSessionId: session.id,
      deviceNo: session.deviceNo,
      online: true,
      readyToBind: true,
      provisionStatus: "ready_to_bind",
      lastOnlineAt: session.lastOnlineAt,
    },
  });
}

function bindDevice(data) {
  const phone = data.phone || "";
  const deviceName = (data.deviceName || "").trim();
  const inputDeviceNo = data.deviceNo || "";
  const normalizedDeviceNo = normalizeDeviceNo(inputDeviceNo);
  const locked = bindLockedFailure(phone, inputDeviceNo, normalizedDeviceNo);
  if (locked) {
    return locked;
  }

  const { registry, record } = getRecord(data.deviceNo);
  if (!record || record.status !== "registered") {
    return bindFailure(phone, inputDeviceNo, normalizedDeviceNo, "DEVICE_NOT_BINDABLE", "设备号不正确", "not_registered");
  }

  const sessions = getProvisionSessions();
  const session = sessions[data.provisionSessionId];
  if (!session || session.deviceNo !== record.deviceNo || session.phone !== phone) {
    return failure("PROVISION_SESSION_NOT_FOUND", "请重新配置设备");
  }
  if (session.status !== "ready_to_bind") {
    return failure("DEVICE_NOT_READY_TO_BIND", "设备未上线，请检查网络");
  }

  const user = ensureUser(phone);
  if (!user) {
    return bindFailure(phone, inputDeviceNo, normalizedDeviceNo, "USER_REQUIRED", "请先登录", "user_required");
  }

  if (record.bindStatus === "bound" && record.ownerPhone && record.ownerPhone !== phone) {
    return bindFailure(phone, inputDeviceNo, record.deviceNo, "DEVICE_ALREADY_BOUND", "设备已被绑定", "bound_by_other");
  }

  if (record.bindStatus === "bound" && record.mockScenario === "sale-bound-online") {
    return bindFailure(phone, inputDeviceNo, record.deviceNo, "DEVICE_ALREADY_BOUND", "设备已被绑定", "bound_by_other");
  }

  const now = Date.now();
  record.bindStatus = "bound";
  record.provisionState = "provisioned";
  record.online = true;
  record.displayStatus = "在线";
  record.ownerPhone = phone;
  record.ownerUserId = user.id;
  record.name = deviceName || record.name;
  record.updatedAt = now;
  registry[record.deviceNo] = record;
  setRegistry(registry);

  session.status = "bound";
  session.boundAt = now;
  session.updatedAt = now;
  sessions[session.id] = session;
  setProvisionSessions(sessions);

  return success({
    user,
    device: createDevicePayload(record, record.name),
  });
}

function addUnprovisionedDevice(data) {
  const phone = data.phone || "";
  const deviceName = (data.deviceName || "").trim();
  const inputDeviceNo = data.deviceNo || "";
  const normalizedDeviceNo = normalizeDeviceNo(inputDeviceNo);
  const locked = bindLockedFailure(phone, inputDeviceNo, normalizedDeviceNo);
  if (locked) {
    return locked;
  }

  const { registry, record } = getRecord(data.deviceNo);
  if (!record || record.status !== "registered") {
    return bindFailure(phone, inputDeviceNo, normalizedDeviceNo, "DEVICE_NOT_BINDABLE", "设备号不正确", "add_unprovisioned_not_registered");
  }

  const user = ensureUser(phone);
  if (!user) {
    return bindFailure(phone, inputDeviceNo, normalizedDeviceNo, "USER_REQUIRED", "请先登录", "user_required");
  }

  if (record.bindStatus === "bound" && record.ownerPhone && record.ownerPhone !== phone) {
    return bindFailure(phone, inputDeviceNo, record.deviceNo, "DEVICE_ALREADY_BOUND", "设备已被绑定", "bound_by_other");
  }
  if (record.bindStatus === "bound" && record.mockScenario === "sale-bound-online") {
    return bindFailure(phone, inputDeviceNo, record.deviceNo, "DEVICE_ALREADY_BOUND", "设备已被绑定", "bound_by_other");
  }
  if (record.bindStatus === "bound" && record.ownerPhone === phone && isRecordProvisioned(record)) {
    return failure("DEVICE_ALREADY_OWNED", "该设备已经是你的设备", { device: createDevicePayload(record, record.name) });
  }

  const now = Date.now();
  record.bindStatus = "bound";
  record.provisionState = "not_provisioned";
  record.online = false;
  record.displayStatus = "未入网";
  record.ownerPhone = phone;
  record.ownerUserId = user.id;
  record.name = deviceName || record.name;
  record.updatedAt = now;
  registry[record.deviceNo] = record;
  setRegistry(registry);

  return success({
    user,
    device: createDevicePayload(record, record.name),
  });
}

function getUserProfile(data) {
  const user = normalizeUser(ensureUser(data.phone || ""));
  if (!user) {
    return failure("SESSION_MISSING", "请先登录");
  }
  return success({
    user: {
      id: user.id,
      phoneMasked: user.phoneMasked,
      status: user.status,
      createdAt: user.createdAt,
      createdAtText: formatTime(new Date(user.createdAt)),
      lastLoginAt: user.updatedAt,
      lastLoginAtText: formatTime(new Date(user.updatedAt)),
    },
    wechatBindings: clone(user.wechatBindings),
  });
}

function bindWechat(data) {
  const users = getUsers();
  const user = normalizeUser(ensureUser(data.phone || ""));
  if (!user) {
    return failure("SESSION_MISSING", "请先登录");
  }
  const now = Date.now();
  const openid = `mock_openid_${user.phone}`;
  const binding = {
    id: `mock_openid_binding_${user.phone}`,
    openid,
    unionid: "",
    appid: "mock_appid",
    source: "mock",
    status: "active",
    createdAt: now,
    createdAtText: formatTime(new Date(now)),
    updatedAt: now,
    updatedAtText: formatTime(new Date(now)),
    lastSeenAt: now,
    lastSeenAtText: formatTime(new Date(now)),
  };
  user.wechatBindings = [binding];
  user.updatedAt = now;
  users[user.phone] = user;
  setUsers(users);
  return success({ user, wechatBinding: binding });
}

function unbindDevice(data) {
  const phone = data.phone || "";
  const { registry, record } = getRecord(data.deviceNo);
  if (!record) {
    return failure("DEVICE_NOT_FOUND", "设备不存在");
  }

  if (record.ownerPhone && record.ownerPhone !== phone) {
    return failure("DEVICE_FORBIDDEN", "无权解绑该设备");
  }

  const now = Date.now();
  record.bindStatus = "unbound";
  record.provisionState = "provisioned";
  record.ownerPhone = null;
  record.ownerUserId = null;
  record.name = record.typeLabel;
  Object.assign(record, emptyConfigState());
  record.lastWateringAt = "--";
  record.lastSyncedAt = null;
  record.displayStatus = record.online ? "在线" : "离线";
  record.updatedAt = now;
  registry[record.deviceNo] = record;
  setRegistry(registry);

  return success({
    deviceNo: record.deviceNo,
    unboundAt: now,
  });
}

function getStatus(data) {
  const { record } = getRecord(data.deviceNo);
  if (!record) {
    return failure("DEVICE_NOT_FOUND", "设备不存在");
  }
  ensureRecordShape(record);

  return success({
    deviceNo: record.deviceNo,
    deviceType: record.type,
    status: getDisplayStatus(record),
    online: record.online && isRecordProvisioned(record),
    bindStatus: record.bindStatus,
    provisionState: record.provisionState || "provisioned",
    provisioned: isRecordProvisioned(record),
    networkState: getNetworkState(record),
    canConfigure: record.bindStatus === "bound" && !isRecordProvisioned(record),
    canBleControl: record.bindStatus === "bound" && (!isRecordProvisioned(record) || !record.online),
    config: clone(record.config || {}),
    configState: record.configState || "unconfigured",
    desiredConfig: record.desiredConfig ? clone(record.desiredConfig) : null,
    desiredConfigVersion: record.desiredConfigVersion || 0,
    appliedConfig: record.appliedConfig ? clone(record.appliedConfig) : null,
    appliedConfigVersion: record.appliedConfigVersion || 0,
    pendingCommandId: record.pendingCommandId || "",
    capabilityState: record.capabilityState || "reported",
    capabilities: clone(record.capabilities || defaultCapabilitiesForType(record.type)),
    runtimeState: clone((record.telemetry && record.telemetry.state) || {}),
    lastWateringAt: record.lastWateringAt || "--",
    lastSyncedAt: record.lastSyncedAt,
    heartbeatIntervalMs: record.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: (record.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS) * 2,
    lastHeartbeatAt: record.lastHeartbeatAt || null,
    lastBootAt: record.lastBootAt || null,
    lastSeenAt: record.lastSeenAt || (record.online ? record.updatedAt : null),
    telemetry: clone(record.telemetry || {}),
    updatedAt: record.updatedAt,
  });
}

function isMockFeatureSupported(record, featureName) {
  ensureRecordShape(record);
  const features = record.capabilities && record.capabilities.features ? record.capabilities.features : {};
  const feature = features[featureName] || {};
  if (!feature.supported) {
    return false;
  }
  if (featureName === "demandWatering") {
    const components = record.capabilities && record.capabilities.components ? record.capabilities.components : {};
    return !!(components.soilMoistureSensor && components.soilMoistureSensor.present);
  }
  return true;
}

function saveWateringConfig(data) {
  const { registry, record } = getRecord(data.deviceNo);
  if (!record || record.type !== "watering") {
    return failure("DEVICE_NOT_FOUND", "设备不存在");
  }
  ensureRecordShape(record);
  if (!record.online || !isRecordProvisioned(record)) {
    return failure(isRecordProvisioned(record) ? "DEVICE_OFFLINE" : "DEVICE_NOT_PROVISIONED", isRecordProvisioned(record) ? "设备离线，无法保存" : "设备未入网，请先配网");
  }

  const now = Date.now();
  const commandId = `mock_cmd_${now}`;
  const config = clone(data.config || {});
  record.config = config;
  record.desiredConfig = config;
  record.desiredConfigVersion = (record.desiredConfigVersion || 0) + 1;
  record.desiredConfigHash = `mock_hash_${record.desiredConfigVersion}`;
  record.appliedConfig = config;
  record.appliedConfigVersion = record.desiredConfigVersion;
  record.appliedConfigHash = record.desiredConfigHash;
  record.configState = "synced";
  record.pendingCommandId = commandId;
  record.lastSyncedAt = now;
  record.updatedAt = now;
  registry[record.deviceNo] = record;
  setRegistry(registry);

  return Promise.resolve({
    success: true,
    code: "COMMAND_ACCEPTED",
    message: "配置命令已接受，等待设备确认",
    data: {
      accepted: true,
      commandId,
      commandStatus: "queued",
      command: {
        id: commandId,
        deviceNo: record.deviceNo,
        commandType: "watering.config.set",
        status: "queued",
        statusText: "等待设备拉取",
        terminal: false,
        payload: { configVersion: record.desiredConfigVersion, configHash: record.desiredConfigHash, config: clone(config) },
        createdAt: now,
      },
      config: clone(record.config),
      desiredConfig: clone(record.desiredConfig),
      desiredConfigVersion: record.desiredConfigVersion,
      desiredConfigHash: record.desiredConfigHash,
      appliedConfig: clone(record.appliedConfig),
      appliedConfigVersion: record.appliedConfigVersion,
      appliedConfigHash: record.appliedConfigHash,
      configState: "pending",
      pendingCommandId: record.pendingCommandId,
      syncedAt: record.lastSyncedAt,
      status: getDisplayStatus(record),
      online: record.online,
    },
  });
}

function startManualWatering(data) {
  const { registry, record } = getRecord(data.deviceNo);
  if (!record || record.type !== "watering") {
    return failure("DEVICE_NOT_FOUND", "设备不存在");
  }
  ensureRecordShape(record);
  if (!isMockFeatureSupported(record, "manualWatering")) {
    return failure("FEATURE_UNSUPPORTED", "设备不支持手动浇水");
  }
  if (!record.online || !isRecordProvisioned(record)) {
    return failure(isRecordProvisioned(record) ? "DEVICE_OFFLINE" : "DEVICE_NOT_PROVISIONED", isRecordProvisioned(record) ? "设备离线，无法下发" : "设备未入网，请先配网");
  }

  const now = Date.now();
  const commandId = `mock_cmd_${now}`;
  record.updatedAt = now;
  registry[record.deviceNo] = record;
  setRegistry(registry);

  return commandAccepted({
    accepted: true,
    commandId,
    commandStatus: "queued",
    command: {
      id: commandId,
      deviceNo: record.deviceNo,
      commandType: "watering.manual.start",
      status: "queued",
      statusText: "等待设备拉取",
      terminal: false,
      payload: { durationSeconds: data.durationSeconds },
      createdAt: now,
    },
    status: getDisplayStatus(record),
    online: record.online,
    durationSeconds: data.durationSeconds,
  }, "手动浇水命令已接受，等待设备执行");
}

function stopManualWatering(data) {
  const { registry, record } = getRecord(data.deviceNo);
  if (!record || record.type !== "watering") {
    return failure("DEVICE_NOT_FOUND", "设备不存在");
  }
  ensureRecordShape(record);
  if (!isMockFeatureSupported(record, "manualWatering")) {
    return failure("FEATURE_UNSUPPORTED", "设备不支持手动浇水");
  }
  if (!record.online || !isRecordProvisioned(record)) {
    return failure(isRecordProvisioned(record) ? "DEVICE_OFFLINE" : "DEVICE_NOT_PROVISIONED", isRecordProvisioned(record) ? "设备离线，无法下发" : "设备未入网，请先配网");
  }

  const now = Date.now();
  const commandId = `mock_cmd_${now}`;
  record.updatedAt = now;
  registry[record.deviceNo] = record;
  setRegistry(registry);

  return commandAccepted({
    accepted: true,
    commandId,
    commandStatus: "queued",
    command: {
      id: commandId,
      deviceNo: record.deviceNo,
      commandType: "watering.manual.stop",
      status: "queued",
      statusText: "等待设备拉取",
      terminal: false,
      payload: {},
      createdAt: now,
    },
    status: getDisplayStatus(record),
    online: record.online,
  }, "停止浇水命令已接受，等待设备执行");
}

function getCommandStatus(data) {
  return success({
    command: {
      id: data.commandId || data.cmdId || "mock_cmd",
      deviceNo: data.deviceNo,
      commandType: "mock.command",
      status: "succeeded",
      statusText: "执行成功",
      terminal: true,
      resultCode: "OK",
      result: { applied: true },
      ackAt: Date.now(),
      ackAtText: formatTime(new Date()),
    },
  });
}

function mockCall(type, data) {
  if (type === "user.getProfile") {
    return getUserProfile(data || {});
  }
  if (type === "auth.bindWechat") {
    return bindWechat(data || {});
  }
  if (type === "device.checkBindable") {
    return checkBindable(data || {});
  }
  if (type === "device.prepareConfigure") {
    return prepareConfigure(data || {});
  }
  if (type === "device.checkProvisionStatus") {
    return checkProvisionStatus(data || {});
  }
  if (type === "device.addUnprovisioned") {
    return addUnprovisionedDevice(data || {});
  }
  if (type === "device.bind") {
    return bindDevice(data || {});
  }
  if (type === "device.unbind") {
    return unbindDevice(data || {});
  }
  if (type === "device.list") {
    return listDevices(data || {});
  }
  if (type === "device.getStatus") {
    return getStatus(data || {});
  }
  if (type === "device.getCommandStatus") {
    return getCommandStatus(data || {});
  }
  if (type === "watering.saveConfig") {
    return saveWateringConfig(data || {});
  }
  if (type === "watering.startManual") {
    return startManualWatering(data || {});
  }
  if (type === "watering.stopManual") {
    return stopManualWatering(data || {});
  }

  return failure("MOCK_NOT_IMPLEMENTED", "接口尚未接入");
}

module.exports = {
  mockCall,
};