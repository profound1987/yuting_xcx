const MOCK_REGISTRY_KEY = "yuntingMockDeviceRegistryV2";
const MOCK_USERS_KEY = "yuntingMockUsersV1";
const DEVICE_CODE_SALT = "YUNTING-ZHIJIA-DEVICE-CODE-V1";
const DEVICE_NO_PATTERN = /^YT-([A-Z]{2})-([0-9A-F]{5})-([0-9A-F]{4})$/;

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
  return {
    mode: "demand",
    demand: {
      intervalHours: 4,
      threshold: 35,
      durationSeconds: 20,
    },
    schedule: {
      intervalDays: 1,
      times: 2,
      durationSeconds: 30,
    },
    manual: {
      durationSeconds: 10,
    },
  };
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
    ownerPhone,
    mockScenario: scenario,
    online,
    displayStatus: online ? "在线" : "离线",
    config: typeInfo.value === "watering" ? createWateringConfig() : {},
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
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  users[phone] = user;
  setUsers(users);
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
  if (record.displayStatus === "浇水中") {
    return "浇水中";
  }
  return record.online ? "在线" : "离线";
}

function createDevicePayload(record, name) {
  return {
    id: record.id,
    deviceNo: record.deviceNo,
    deviceSerial: record.serial,
    deviceTypeCode: record.typeCode,
    name: name || record.name,
    type: record.type,
    typeLabel: record.typeLabel,
    status: getDisplayStatus(record),
    online: record.online,
    bindStatus: record.bindStatus,
    ownerPhone: record.ownerPhone,
    mockScenario: record.mockScenario,
    config: clone(record.config || {}),
    lastWateringAt: record.lastWateringAt || "--",
    lastSyncedAt: record.lastSyncedAt,
    syncState: record.online ? "synced" : "offline",
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

function failure(code, message) {
  return Promise.resolve({
    success: false,
    code,
    message,
    data: null,
  });
}

function checkBindable(data) {
  const { record } = getRecord(data.deviceNo);
  const bindable = !!(record && record.status === "registered" && record.bindStatus === "unbound" && record.online);
  return success({ bindable });
}

function bindDevice(data) {
  const phone = data.phone || "";
  const deviceName = (data.deviceName || "").trim();
  const { registry, record } = getRecord(data.deviceNo);
  if (!record || record.status !== "registered") {
    return failure("DEVICE_NOT_BINDABLE", "设备号不正确");
  }

  const user = ensureUser(phone);
  if (!user) {
    return failure("USER_REQUIRED", "请先登录");
  }

  if (record.bindStatus === "bound" && record.ownerPhone && record.ownerPhone !== phone) {
    return failure("DEVICE_ALREADY_BOUND", "设备已被绑定");
  }

  if (record.bindStatus === "bound" && record.mockScenario === "sale-bound-online") {
    return failure("DEVICE_ALREADY_BOUND", "设备已被绑定");
  }

  record.bindStatus = "bound";
  record.ownerPhone = phone;
  record.ownerUserId = user.id;
  record.name = deviceName || record.name;
  record.updatedAt = Date.now();
  registry[record.deviceNo] = record;
  setRegistry(registry);

  return success({
    user,
    device: createDevicePayload(record, record.name),
  });
}

function getStatus(data) {
  const { record } = getRecord(data.deviceNo);
  if (!record) {
    return failure("DEVICE_NOT_FOUND", "设备不存在");
  }

  return success({
    deviceNo: record.deviceNo,
    status: getDisplayStatus(record),
    online: record.online,
    config: clone(record.config || {}),
    lastWateringAt: record.lastWateringAt || "--",
    lastSyncedAt: record.lastSyncedAt,
    updatedAt: record.updatedAt,
  });
}

function saveWateringConfig(data) {
  const { registry, record } = getRecord(data.deviceNo);
  if (!record || record.type !== "watering") {
    return failure("DEVICE_NOT_FOUND", "设备不存在");
  }
  if (!record.online) {
    return failure("DEVICE_OFFLINE", "设备离线，无法保存");
  }

  const now = Date.now();
  record.config = clone(data.config || createWateringConfig());
  record.lastSyncedAt = now;
  record.updatedAt = now;
  registry[record.deviceNo] = record;
  setRegistry(registry);

  return success({
    config: clone(record.config),
    syncedAt: now,
    status: getDisplayStatus(record),
    online: record.online,
  });
}

function startManualWatering(data) {
  const { registry, record } = getRecord(data.deviceNo);
  if (!record || record.type !== "watering") {
    return failure("DEVICE_NOT_FOUND", "设备不存在");
  }
  if (!record.online) {
    return failure("DEVICE_OFFLINE", "设备离线，无法下发");
  }

  const now = Date.now();
  record.displayStatus = "浇水中";
  record.lastWateringAt = formatTime(new Date(now));
  record.lastSyncedAt = now;
  record.updatedAt = now;
  registry[record.deviceNo] = record;
  setRegistry(registry);

  return success({
    status: getDisplayStatus(record),
    online: record.online,
    lastWateringAt: record.lastWateringAt,
    syncedAt: now,
    durationSeconds: data.durationSeconds,
  });
}

function stopManualWatering(data) {
  const { registry, record } = getRecord(data.deviceNo);
  if (!record || record.type !== "watering") {
    return failure("DEVICE_NOT_FOUND", "设备不存在");
  }
  if (!record.online) {
    return failure("DEVICE_OFFLINE", "设备离线，无法下发");
  }

  const now = Date.now();
  record.displayStatus = "在线";
  record.lastSyncedAt = now;
  record.updatedAt = now;
  registry[record.deviceNo] = record;
  setRegistry(registry);

  return success({
    status: getDisplayStatus(record),
    online: record.online,
    syncedAt: now,
  });
}

function mockCall(type, data) {
  if (type === "device.checkBindable") {
    return checkBindable(data || {});
  }
  if (type === "device.bind") {
    return bindDevice(data || {});
  }
  if (type === "device.getStatus") {
    return getStatus(data || {});
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