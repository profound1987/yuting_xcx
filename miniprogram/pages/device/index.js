const SESSION_KEY = "yuntingSession";
const DEVICES_KEY_PREFIX = "yuntingDevices";
const MANUAL_DURATION_KEY_PREFIX = "yuntingManualDuration";
const BLE_PIN_KEY_PREFIX = "yuntingBlePin";
const DEVICE_LOCAL_STATE_KEY_PREFIX = "yuntingDeviceLocalState";
const { callApi, apiConfig } = require("../../services/apiClient");
const { createBleSecureFrame } = require("../../utils/blePinCrypto");

const LOCAL_CONTROL_SERVICE_UUID = "0000FFF0-0000-1000-8000-00805F9B34FB";
const LOCAL_CONTROL_WRITE_UUID = "0000FFF1-0000-1000-8000-00805F9B34FB";
const LOCAL_CONTROL_NOTIFY_UUID = "0000FFF2-0000-1000-8000-00805F9B34FB";
const BLE_WRITE_CHUNK_SIZE = 20;
const BLE_WRITE_CHUNK_DELAY_MS = 50;
const BLE_CONTROL_SCAN_TIMEOUT_MS = 12000;
const BLE_CONTROL_ACK_TIMEOUT_MS = 30000;
const BLE_CONTROL_ACK_BUFFER_MS = 10000;
const DEVICE_PIN_PATTERN = /^\d{4,8}$/;

const FEATURE_LABELS = {
  demandWatering: "按需浇水",
  scheduleWatering: "定期浇水",
  manualWatering: "手动浇水",
};

const FEATURE_SHORT_LABELS = {
  demandWatering: "按需",
  scheduleWatering: "定期",
  manualWatering: "手动",
};

const AUTO_FEATURES = {
  demandWatering: true,
  scheduleWatering: true,
};

const FEATURE_FIELDS = {
  demandWatering: [
    { field: "checkIntervalHours", label: "检测周期", fallbackMin: 1, fallbackMax: 72, fallbackRecommended: 4 },
    { field: "thresholdPercent", label: "湿度阈值", fallbackMin: 1, fallbackMax: 100, fallbackRecommended: 35 },
    { field: "durationSeconds", label: "浇水时长", fallbackMin: 1, fallbackMax: 3600, fallbackRecommended: 20 },
  ],
  scheduleWatering: [
    { field: "intervalDays", label: "间隔天数", fallbackMin: 1, fallbackMax: 365, fallbackRecommended: 1 },
    { field: "timesPerDay", label: "每天次数", fallbackMin: 1, fallbackMax: 24, fallbackRecommended: 2 },
    { field: "durationSeconds", label: "浇水时长", fallbackMin: 1, fallbackMax: 3600, fallbackRecommended: 30 },
  ],
  manualWatering: [
    { field: "durationSeconds", label: "浇水秒数", fallbackMin: 1, fallbackMax: 3600, fallbackRecommended: 10 },
  ],
};

function getDevicesKey(phone) {
  return `${DEVICES_KEY_PREFIX}_${phone}`;
}

function getStoredDevices(phone) {
  return wx.getStorageSync(getDevicesKey(phone)) || [];
}

function setStoredDevices(phone, devices) {
  wx.setStorageSync(getDevicesKey(phone), devices);
}

function getManualDurationKey(deviceNo) {
  return `${MANUAL_DURATION_KEY_PREFIX}_${deviceNo || "unknown"}`;
}

function getCachedManualDuration(deviceNo) {
  return wx.getStorageSync(getManualDurationKey(deviceNo)) || "";
}

function setCachedManualDuration(deviceNo, duration) {
  wx.setStorageSync(getManualDurationKey(deviceNo), String(duration || ""));
}

function getBlePinKey(deviceNo) {
  return `${BLE_PIN_KEY_PREFIX}_${deviceNo || "unknown"}`;
}

function getCachedBlePin(deviceNo) {
  return normalizePin(wx.getStorageSync(getBlePinKey(deviceNo)) || "");
}

function setCachedBlePin(deviceNo, pin) {
  const normalized = normalizePin(pin);
  if (deviceNo && isValidPin(normalized)) {
    wx.setStorageSync(getBlePinKey(deviceNo), normalized);
  }
}

function formatTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePin(value) {
  return String(value || "").trim();
}

function isValidPin(value) {
  return DEVICE_PIN_PATTERN.test(normalizePin(value));
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
  return toBufferChunks(bytes, BLE_WRITE_CHUNK_SIZE);
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
    return bytes.map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "")).join("").trim();
  }
}

function bytesToRawText(bytes) {
  if (!bytes || !bytes.length) {
    return "";
  }
  const encoded = bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  try {
    return decodeURIComponent(encoded).replace(/\u0000/g, "");
  } catch (error) {
    return bytes.map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "")).join("");
  }
}

function bufferToText(buffer) {
  return bytesToRawText(arrayBufferToBytes(buffer));
}

function normalizeUuid(value) {
  return String(value || "").toUpperCase();
}

function createBleCommandId() {
  return `ble_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function getBleAckStatus(payload) {
  return String((payload && (payload.status || payload.state)) || "").trim().toLowerCase();
}

function isBleAckSuccess(payload) {
  const status = getBleAckStatus(payload);
  const code = String((payload && payload.code) || "").trim().toUpperCase();
  if (status) {
    return status === "succeeded" || status === "success" || status === "completed" || status === "done";
  }
  return code === "OK";
}

function isBleAckFailure(payload) {
  const status = getBleAckStatus(payload);
  const code = String((payload && payload.code) || "").trim().toUpperCase();
  return status === "failed" || status === "fail" || status === "error" || /FAILED|ERROR|TIMEOUT|INVALID|EXPIRED|DENIED/.test(code);
}

function getBleAckMessage(payload, fallback) {
  return (payload && payload.message) || fallback || "设备已完成命令";
}

function getBleCommandAckTimeout(options) {
  const duration = Number((options && (options.duration || (options.params && options.params.durationSeconds))) || 0);
  if (duration > 0) {
    return Math.max(BLE_CONTROL_ACK_TIMEOUT_MS, duration * 1000 + BLE_CONTROL_ACK_BUFFER_MS);
  }
  return BLE_CONTROL_ACK_TIMEOUT_MS;
}

function getAdvertisedName(advertisData) {
  const bytes = arrayBufferToBytes(advertisData);
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes[offset];
    if (!length) {
      break;
    }
    const type = bytes[offset + 1];
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

function normalizeInteger(value, min, max) {
  if (!/^\d+$/.test(String(value).trim())) {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  if (number < min || number > max) {
    return null;
  }
  return number;
}

function isDeviceProvisioned(device) {
  return !(device && (device.provisioned === false || device.provisionState === "not_provisioned" || device.networkState === "not_provisioned" || device.status === "未入网"));
}

function isDeviceOnline(device) {
  return !!(device && isDeviceProvisioned(device) && device.online !== false && device.status !== "离线");
}

function canUseBleControl(device) {
  return !!(device && (device.canBleControl || !isDeviceOnline(device) || !isDeviceProvisioned(device)));
}

function shouldUseBleControl(device) {
  return !!(device && (!isDeviceProvisioned(device) || !isDeviceOnline(device)));
}

function getSyncText(device) {
  if (!isDeviceProvisioned(device)) {
    return "未入网";
  }
  if (!isDeviceOnline(device)) {
    return "离线可蓝牙控制";
  }
  const state = device && device.configState ? device.configState : "unconfigured";
  if (state === "unconfigured") {
    return "未配置";
  }
  if (state === "pending") {
    return "待设备确认";
  }
  if (state === "failed") {
    return "同步失败";
  }
  if (state === "synced") {
    return "已同步";
  }
  return "在线可配置";
}

function getResponseMessage(resp, fallback) {
  return (resp && resp.message) || fallback;
}

const COMMAND_STATUS_TEXT = {
  queued: "已提交给服务器，等待设备接收",
  sent: "已提交给服务器，等待设备接收",
  received: "设备已接收命令，等待执行完成",
  executing: "设备正在执行，等待完成",
  succeeded: "设备执行完成",
  failed: "设备执行失败",
  expired: "命令已过期",
  delivery_timeout: "设备未及时接收命令",
  execution_timeout: "设备执行超时",
  publish_failed: "命令下发失败",
};

const COMMAND_PROGRESS = {
  queued: 33,
  sent: 33,
  received: 66,
  executing: 66,
  succeeded: 100,
  failed: 66,
  expired: 33,
  delivery_timeout: 33,
  execution_timeout: 66,
  publish_failed: 33,
};

const COMMAND_COLORS = {
  running: "#087d91",
  success: "#1f8f68",
  failed: "#c2573d",
};

function commandStatusText(command) {
  if (!command) {
    return "正在提交命令";
  }
  return COMMAND_STATUS_TEXT[command.status] || command.statusText || "等待设备确认";
}

function isTerminalCommandStatus(status) {
  return status === "succeeded" || status === "failed" || status === "expired" || status === "delivery_timeout" || status === "execution_timeout" || status === "publish_failed";
}

function commandProgressForStatus(status, currentProgress) {
  if (status === "succeeded") {
    return 100;
  }
  if (status === "failed") {
    return Math.max(66, Math.min(currentProgress || 66, 66));
  }
  if (status === "execution_timeout") {
    return 66;
  }
  if (status === "delivery_timeout" || status === "publish_failed" || status === "expired") {
    return Math.max(33, Math.min(currentProgress || 33, 66));
  }
  return COMMAND_PROGRESS[status] || 33;
}

function getFeatures(capabilities) {
  return capabilities && capabilities.features && typeof capabilities.features === "object" ? capabilities.features : {};
}

function getComponents(capabilities) {
  return capabilities && capabilities.components && typeof capabilities.components === "object" ? capabilities.components : {};
}

function getFeature(capabilities, featureName) {
  const features = getFeatures(capabilities);
  return features[featureName] && typeof features[featureName] === "object" ? features[featureName] : {};
}

function isFeatureSupported(capabilities, featureName) {
  const feature = getFeature(capabilities, featureName);
  if (!feature.supported) {
    return false;
  }
  if (featureName === "demandWatering") {
    const soilSensor = getComponents(capabilities).soilMoistureSensor;
    return !!(soilSensor && soilSensor.present);
  }
  return true;
}

function getFeatureTabs(capabilities) {
  return ["demandWatering", "scheduleWatering", "manualWatering"]
    .filter((featureName) => isFeatureSupported(capabilities, featureName))
    .map((featureName) => ({
      value: featureName,
      label: FEATURE_SHORT_LABELS[featureName] || FEATURE_LABELS[featureName] || featureName,
      fullLabel: FEATURE_LABELS[featureName] || featureName,
      autoConfig: !!AUTO_FEATURES[featureName],
    }));
}

function getParamRule(capabilities, featureName, fieldName) {
  const feature = getFeature(capabilities, featureName);
  const params = feature.params && typeof feature.params === "object" ? feature.params : {};
  const rule = params[fieldName] && typeof params[fieldName] === "object" ? params[fieldName] : {};
  const fallback = (FEATURE_FIELDS[featureName] || []).find((item) => item.field === fieldName) || {};
  return {
    min: Number(rule.min || fallback.fallbackMin || 1),
    max: Number(rule.max || fallback.fallbackMax || 3600),
    recommended: rule.recommended !== undefined && rule.recommended !== null ? rule.recommended : fallback.fallbackRecommended,
    unit: rule.unit || "",
  };
}

function recommendedText(capabilities, featureName, fieldName) {
  const rule = getParamRule(capabilities, featureName, fieldName);
  return rule.recommended === undefined || rule.recommended === null ? "" : String(rule.recommended);
}

function createEmptyDraft() {
  return {
    schemaVersion: 1,
    enabledFeatures: [],
    automationMode: "",
    features: {
      demandWatering: {
        checkIntervalHours: "",
        thresholdPercent: "",
        durationSeconds: "",
      },
      scheduleWatering: {
        intervalDays: "",
        timesPerDay: "",
        durationSeconds: "",
      },
    },
  };
}

function buildPlaceholders() {
  return {
    demandWatering: {
      checkIntervalHours: "",
      thresholdPercent: "",
      durationSeconds: "",
    },
    scheduleWatering: {
      intervalDays: "",
      timesPerDay: "",
      durationSeconds: "",
    },
    manualWatering: {
      durationSeconds: "",
    },
  };
}

function legacyConfigToNew(config) {
  if (!config || typeof config !== "object" || !config.mode) {
    return config || {};
  }
  if (config.mode === "demand") {
    const demand = config.demand || {};
    return {
      schemaVersion: 1,
      enabledFeatures: ["demandWatering"],
      automationMode: "demandWatering",
      features: {
        demandWatering: {
          checkIntervalHours: demand.intervalHours,
          thresholdPercent: demand.threshold,
          durationSeconds: demand.durationSeconds,
        },
      },
    };
  }
  if (config.mode === "schedule") {
    const schedule = config.schedule || {};
    return {
      schemaVersion: 1,
      enabledFeatures: ["scheduleWatering"],
      automationMode: "scheduleWatering",
      features: {
        scheduleWatering: {
          intervalDays: schedule.intervalDays,
          timesPerDay: schedule.times || schedule.timesPerDay,
          durationSeconds: schedule.durationSeconds,
        },
      },
    };
  }
  return {};
}

function normalizeConfig(config) {
  const nextConfig = legacyConfigToNew(config || {});
  const features = nextConfig.features && typeof nextConfig.features === "object" ? nextConfig.features : {};
  return {
    schemaVersion: nextConfig.schemaVersion || 1,
    enabledFeatures: Array.isArray(nextConfig.enabledFeatures) ? nextConfig.enabledFeatures : [],
    automationMode: nextConfig.automationMode || "",
    features,
  };
}

function hasConfigContent(config) {
  const normalizedConfig = normalizeConfig(config || {});
  return !!(
    normalizedConfig.automationMode
    || (normalizedConfig.enabledFeatures && normalizedConfig.enabledFeatures.length)
    || (normalizedConfig.features && Object.keys(normalizedConfig.features).length)
  );
}

function simpleStableHash(value) {
  const text = JSON.stringify(value || {});
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function buildLocalConfigParams(device, config) {
  const currentVersion = Number((device && (device.appliedConfigVersion || device.desiredConfigVersion)) || 0);
  return {
    configVersion: currentVersion + 1,
    configHash: `ble-${simpleStableHash(config)}`,
    config,
  };
}

function getDeviceLocalStateKey(deviceNo) {
  return `${DEVICE_LOCAL_STATE_KEY_PREFIX}_${deviceNo || "unknown"}`;
}

function getCachedDeviceLocalState(deviceNo) {
  const state = wx.getStorageSync(getDeviceLocalStateKey(deviceNo));
  return state && typeof state === "object" ? state : {};
}

function setCachedDeviceLocalState(deviceNo, patch) {
  if (!deviceNo || !patch || typeof patch !== "object") {
    return;
  }
  const current = getCachedDeviceLocalState(deviceNo);
  wx.setStorageSync(getDeviceLocalStateKey(deviceNo), Object.assign({}, current, patch, { updatedAt: Date.now() }));
}

function getConfigSnapshotForDevice(device) {
  const config = device && (device.appliedConfig || device.desiredConfig || device.config);
  return hasConfigContent(config) ? config : null;
}

function cacheDeviceLocalFields(device) {
  if (!device || !device.deviceNo) {
    return;
  }
  const patch = {};
  const config = getConfigSnapshotForDevice(device);
  if (config && device.configState === "synced") {
    patch.config = device.config || config;
    patch.desiredConfig = device.desiredConfig || config;
    patch.appliedConfig = device.appliedConfig || config;
    patch.configState = device.configState || "synced";
    patch.desiredConfigVersion = device.desiredConfigVersion || 0;
    patch.appliedConfigVersion = device.appliedConfigVersion || 0;
    patch.desiredConfigHash = device.desiredConfigHash || "";
    patch.appliedConfigHash = device.appliedConfigHash || "";
    patch.lastSyncedAt = device.lastSyncedAt || "";
  }
  if (device.lastWateringAt) {
    patch.lastWateringAt = device.lastWateringAt;
  }
  if (Object.keys(patch).length) {
    setCachedDeviceLocalState(device.deviceNo, patch);
  }
}

function isLocalStateNewer(localState, device) {
  const localUpdatedAt = Number((localState && localState.updatedAt) || 0);
  const remoteUpdatedAt = Number((device && device.updatedAt) || 0);
  return !!(localUpdatedAt && (!remoteUpdatedAt || localUpdatedAt >= remoteUpdatedAt));
}

function mergeLocalDeviceState(device) {
  if (!device || !device.deviceNo) {
    return device;
  }
  const localState = getCachedDeviceLocalState(device.deviceNo);
  if (!localState || !Object.keys(localState).length) {
    return device;
  }
  const nextDevice = Object.assign({}, device);
  const localConfig = localState.appliedConfig || localState.desiredConfig || localState.config;
  const remoteConfig = device.appliedConfig || device.desiredConfig || device.config;
  const localStateNewer = isLocalStateNewer(localState, device);
  const shouldUseLocalConfig = hasConfigContent(localConfig) && (
    localStateNewer
    || !isDeviceOnline(device)
    || !hasConfigContent(remoteConfig)
    || device.configState === "unconfigured"
  );
  if (shouldUseLocalConfig) {
    nextDevice.config = localState.config || localConfig;
    nextDevice.desiredConfig = localState.desiredConfig || localConfig;
    nextDevice.appliedConfig = localState.appliedConfig || localConfig;
    nextDevice.configState = localState.configState || "synced";
    nextDevice.desiredConfigVersion = localState.desiredConfigVersion || nextDevice.desiredConfigVersion || 0;
    nextDevice.appliedConfigVersion = localState.appliedConfigVersion || nextDevice.appliedConfigVersion || 0;
    nextDevice.desiredConfigHash = localState.desiredConfigHash || nextDevice.desiredConfigHash || "";
    nextDevice.appliedConfigHash = localState.appliedConfigHash || nextDevice.appliedConfigHash || "";
    nextDevice.pendingCommandId = localState.pendingCommandId || "";
    nextDevice.lastSyncedAt = localState.lastSyncedAt || nextDevice.lastSyncedAt;
  }
  if (localState.lastWateringAt && (!nextDevice.lastWateringAt || localStateNewer || !isDeviceOnline(device) || String(localState.lastWateringAt) > String(nextDevice.lastWateringAt))) {
    nextDevice.lastWateringAt = localState.lastWateringAt;
  }
  return nextDevice;
}

function configSourceForDevice(device) {
  const state = device && device.configState ? device.configState : "unconfigured";
  if (state === "unconfigured") {
    return normalizeConfig({});
  }
  return normalizeConfig(device.desiredConfig || device.appliedConfig || device.config || {});
}

function draftFromConfig(config) {
  const draft = createEmptyDraft();
  const normalizedConfig = normalizeConfig(config);
  draft.enabledFeatures = normalizedConfig.enabledFeatures.slice();
  draft.automationMode = normalizedConfig.automationMode;
  Object.keys(draft.features).forEach((featureName) => {
    const source = normalizedConfig.features[featureName] || {};
    Object.keys(draft.features[featureName]).forEach((fieldName) => {
      const value = source[fieldName];
      draft.features[featureName][fieldName] = value === undefined || value === null ? "" : String(value);
    });
  });
  return draft;
}

function selectFeature(tabs, config, preferredFeature) {
  const supportedValues = tabs.map((item) => item.value);
  if (preferredFeature && supportedValues.indexOf(preferredFeature) >= 0) {
    return preferredFeature;
  }
  if (config.automationMode && supportedValues.indexOf(config.automationMode) >= 0) {
    return config.automationMode;
  }
  const enabled = (config.enabledFeatures || []).find((featureName) => supportedValues.indexOf(featureName) >= 0);
  if (enabled) {
    return enabled;
  }
  return tabs.length ? tabs[0].value : "";
}

function prepareDeviceForUi(device) {
  const nextDevice = Object.assign({}, device || {});
  if (nextDevice.type === "watering") {
    nextDevice.configState = nextDevice.configState || "unconfigured";
    nextDevice.config = nextDevice.configState === "unconfigured" ? {} : (nextDevice.config || {});
    nextDevice.desiredConfig = nextDevice.desiredConfig || null;
    nextDevice.appliedConfig = nextDevice.appliedConfig || null;
    nextDevice.capabilityState = nextDevice.capabilityState || (nextDevice.capabilities ? "reported" : "pending");
    nextDevice.capabilities = nextDevice.capabilities || {};
  }
  return nextDevice;
}

function buildWateringUi(device, preferredFeature, currentState) {
  const capabilities = device && device.capabilities ? device.capabilities : {};
  const tabs = getFeatureTabs(capabilities);
  const config = configSourceForDevice(device || {});
  const selected = selectFeature(tabs, config, preferredFeature);
  const selectedIsManual = selected === "manualWatering";
  const selectedIsAuto = !!AUTO_FEATURES[selected];
  const capabilityReady = !!(device && device.capabilityState === "reported" && tabs.length);
  const cachedManualDuration = currentState && currentState.manualDuration
    ? currentState.manualDuration
    : getCachedManualDuration(device && device.deviceNo);
  return {
    featureTabs: tabs,
    hasFeatureTabs: tabs.length > 0,
    selectedFeature: selected,
    selectedIsManual,
    selectedIsAuto,
    modeText: selected ? (FEATURE_LABELS[selected] || "设备管理") : "设备管理",
    configDraft: draftFromConfig(config),
    placeholders: buildPlaceholders(),
    manualDuration: cachedManualDuration || "",
    manualProgressPercent: 0,
    capabilityReady,
    canSaveConfig: selectedIsAuto && (isDeviceOnline(device) || canUseBleControl(device)),
  };
}

function buildDeviceState(device, preferredFeature, currentState) {
  const nextDevice = prepareDeviceForUi(device);
  const baseState = {
    device: nextDevice,
    canEdit: isDeviceOnline(nextDevice) || canUseBleControl(nextDevice),
    syncText: getSyncText(nextDevice),
  };
  if (nextDevice.type !== "watering") {
    return Object.assign(baseState, {
      modeText: "设备管理",
      featureTabs: [],
      hasFeatureTabs: false,
      selectedFeature: "",
      selectedIsManual: false,
      selectedIsAuto: false,
      canSaveConfig: false,
    });
  }
  return Object.assign(baseState, buildWateringUi(nextDevice, preferredFeature, currentState));
}

Page({
  data: {
    deviceId: "",
    phone: "",
    device: null,
    modeText: "设备管理",
    featureTabs: [],
    hasFeatureTabs: false,
    selectedFeature: "",
    selectedIsManual: false,
    selectedIsAuto: false,
    capabilityReady: false,
    configDraft: createEmptyDraft(),
    placeholders: buildPlaceholders(),
    manualDuration: "",
    manualProgressPercent: 0,
    manualRunning: false,
    manualLeft: 0,
    manualTotal: 0,
    canEdit: false,
    canSaveConfig: false,
    syncText: "",
    syncing: false,
    commandBusy: false,
    activeCommandId: "",
    activeCommandKind: "",
    commandDialogVisible: false,
    commandDialogTitle: "",
    commandDialogText: "",
    commandDialogStatus: "",
    commandDialogProgress: 0,
    commandDialogColor: COMMAND_COLORS.running,
    commandDialogClosable: false,
    commandCountdownVisible: false,
    commandCountdownLeft: 0,
    commandCountdownTotal: 0,
    commandCountdownText: "",
    commandStep1Text: "已提交给服务器",
    commandStep2Text: "设备已接收",
    commandStep3Text: "设备已完成",
    blePinDialogVisible: false,
    blePinInput: "",
    blePinError: "",
  },

  onLoad(options) {
    const session = wx.getStorageSync(SESSION_KEY);
    if (!session || !session.phone) {
      wx.redirectTo({ url: "/pages/index/index" });
      return;
    }
    this.setData({ phone: session.phone });
    this.setData({ deviceId: options.id || "" });
    this.loadDevice(options.id);
  },

  onShow() {
    if (this.data.device) {
      this.refreshDeviceStatus(false);
    }
  },

  onUnload() {
    this.clearManualTimer();
    this.clearCommandPollTimer();
    this.clearCommandCountdownTimer();
    this.cleanupBleControlNotify();
  },

  loadDevice(id) {
    const devices = getStoredDevices(this.data.phone);
    const device = devices.find((item) => item.id === id);
    if (!device) {
      wx.showToast({ title: "设备不存在", icon: "none" });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const cachedPin = getCachedBlePin(device.deviceNo);
    const withCachedPin = isValidPin(device.blePin) || !isValidPin(cachedPin)
      ? device
      : Object.assign({}, device, { blePin: cachedPin });
    const nextDevice = mergeLocalDeviceState(withCachedPin);
    this.setData(buildDeviceState(nextDevice, "", this.data));
    this.refreshDeviceStatus(false);
  },

  refreshDeviceStatus(showLoading) {
    const device = this.data.device;
    if (!device || !device.deviceNo) {
      return;
    }

    if (showLoading) {
      wx.showLoading({ title: "同步中..." });
    }
    callApi("device.getStatus", {
      phone: this.data.phone,
      deviceNo: device.deviceNo,
    }).then((resp) => {
      if (!resp || !resp.success || !resp.data) {
        return;
      }

      const statusData = resp.data;
      const currentDevice = this.data.device || {};
      const statusOnline = statusData.online !== false;
      const localConfig = currentDevice.config || currentDevice.desiredConfig || currentDevice.appliedConfig || {};
      const preserveLocalConfig = !statusOnline && hasConfigContent(localConfig);
      const nextDevice = Object.assign({}, currentDevice, {
        status: statusData.status || currentDevice.status,
        online: statusOnline,
        bindStatus: statusData.bindStatus || currentDevice.bindStatus,
        provisionState: statusData.provisionState || currentDevice.provisionState || "provisioned",
        provisioned: statusData.provisioned !== false,
        networkState: statusData.networkState || currentDevice.networkState || (statusData.online === false ? "offline" : "online"),
        canConfigure: !!statusData.canConfigure,
        canBleControl: !!statusData.canBleControl,
        config: preserveLocalConfig ? localConfig : (statusData.config || currentDevice.config || {}),
        configState: preserveLocalConfig ? (currentDevice.configState || statusData.configState || "unconfigured") : (statusData.configState || currentDevice.configState || "unconfigured"),
        desiredConfig: preserveLocalConfig ? (currentDevice.desiredConfig || localConfig) : (statusData.desiredConfig || currentDevice.desiredConfig || null),
        appliedConfig: preserveLocalConfig ? (currentDevice.appliedConfig || localConfig) : (statusData.appliedConfig || currentDevice.appliedConfig || null),
        desiredConfigVersion: preserveLocalConfig ? (currentDevice.desiredConfigVersion || statusData.desiredConfigVersion || 0) : (statusData.desiredConfigVersion || 0),
        appliedConfigVersion: preserveLocalConfig ? (currentDevice.appliedConfigVersion || statusData.appliedConfigVersion || 0) : (statusData.appliedConfigVersion || 0),
        pendingCommandId: preserveLocalConfig ? (currentDevice.pendingCommandId || statusData.pendingCommandId || "") : (statusData.pendingCommandId || ""),
        capabilityState: statusData.capabilityState || currentDevice.capabilityState,
        capabilities: statusData.capabilities || currentDevice.capabilities || {},
        telemetry: statusData.telemetry || currentDevice.telemetry || {},
        runtimeState: statusData.runtimeState || currentDevice.runtimeState || {},
        lastWateringAt: statusData.lastWateringAt || currentDevice.lastWateringAt,
        lastSyncedAt: preserveLocalConfig ? (currentDevice.lastSyncedAt || statusData.lastSyncedAt) : (statusData.lastSyncedAt || currentDevice.lastSyncedAt),
        updatedAt: statusData.updatedAt || currentDevice.updatedAt,
      });

      const mergedDevice = mergeLocalDeviceState(nextDevice);
      this.setData(buildDeviceState(mergedDevice, this.data.selectedFeature, this.data));
      this.persistDevice(false);
    }).catch(() => {
      if (showLoading) {
        wx.showToast({ title: "同步失败", icon: "none" });
      }
    }).finally(() => {
      if (showLoading) {
        wx.hideLoading();
      }
    });
  },

  ensureEditable() {
    if (!this.data.canEdit) {
      wx.showToast({ title: "设备不可控制", icon: "none" });
      return false;
    }
    return true;
  },

  goConfigure() {
    const device = this.data.device;
    if (!device || !device.deviceNo) {
      return;
    }
    const pin = normalizePin(device.blePin || getCachedBlePin(device.deviceNo));
    const pinQuery = isValidPin(pin) ? `&pin=${encodeURIComponent(pin)}` : "";
    wx.navigateTo({ url: `/pages/configure/index?deviceNo=${encodeURIComponent(device.deviceNo)}&deviceName=${encodeURIComponent(device.name || "")}${pinQuery}` });
  },

  selectFeature(e) {
    if (!this.data.canEdit || this.data.manualRunning || this.data.commandBusy) {
      return;
    }
    const feature = e.currentTarget.dataset.feature;
    const selectedIsAuto = !!AUTO_FEATURES[feature];
    this.setData({
      selectedFeature: feature,
      selectedIsManual: feature === "manualWatering",
      selectedIsAuto,
      canSaveConfig: selectedIsAuto && (isDeviceOnline(this.data.device) || canUseBleControl(this.data.device)),
      modeText: FEATURE_LABELS[feature] || "设备管理",
    });
  },

  onConfigInput(e) {
    if (!this.data.canEdit || this.data.commandBusy) {
      return;
    }
    const { feature, field } = e.currentTarget.dataset;
    const key = `configDraft.features.${feature}.${field}`;
    this.setData({ [key]: e.detail.value });
  },

  onManualDurationInput(e) {
    if (!this.data.canEdit || this.data.commandBusy) {
      return;
    }
    if (shouldUseBleControl(this.data.device) && this.data.selectedFeature !== "manualWatering") {
      return;
    }
    const value = e.detail.value;
    if (this.data.device && this.data.device.deviceNo) {
      setCachedManualDuration(this.data.device.deviceNo, value);
    }
    this.setData({ manualDuration: value });
  },

  validateFeatureDraft(feature) {
    const capabilities = this.data.device.capabilities || {};
    const draft = this.data.configDraft.features[feature] || {};
    const params = {};
    const fields = FEATURE_FIELDS[feature] || [];
    for (let index = 0; index < fields.length; index += 1) {
      const item = fields[index];
      const rule = getParamRule(capabilities, feature, item.field);
      const value = normalizeInteger(draft[item.field], rule.min, rule.max);
      if (value === null) {
        wx.showToast({ title: `${item.label}范围${rule.min}-${rule.max}`, icon: "none" });
        return null;
      }
      params[item.field] = value;
    }
    return params;
  },

  saveConfig() {
    if (!this.ensureEditable()) {
      return;
    }

    if (this.data.commandBusy) {
      return;
    }

    if (this.data.manualRunning) {
      wx.showToast({ title: "浇水中，稍后保存", icon: "none" });
      return;
    }

    const feature = this.data.selectedFeature;
    if (!AUTO_FEATURES[feature]) {
      wx.showToast({ title: "请选择自动浇水功能", icon: "none" });
      return;
    }

    const params = this.validateFeatureDraft(feature);
    if (!params) {
      return;
    }

    const nextConfig = {
      schemaVersion: 1,
      enabledFeatures: [feature],
      automationMode: feature,
      features: {
        [feature]: params,
      },
    };

    if (shouldUseBleControl(this.data.device)) {
      const localConfigParams = buildLocalConfigParams(this.data.device, nextConfig);
      this.executeBleControlCommand({
        kind: "config",
        title: "蓝牙保存设置",
        commandType: "watering.config.set",
        params: localConfigParams,
        config: nextConfig,
        configVersion: localConfigParams.configVersion,
        configHash: localConfigParams.configHash,
        feature,
        successText: "设备已保存本地浇水设置",
      });
      return;
    }

    this.openCommandDialog("config", "保存设置", "正在提交配置命令");
    callApi("watering.saveConfig", {
      phone: this.data.phone,
      deviceNo: this.data.device.deviceNo,
      config: nextConfig,
    }).then((resp) => {
      if (!resp || !resp.success || !resp.data) {
        this.failCommandBeforeAccepted(getResponseMessage(resp, "保存失败"));
        return;
      }

      const savedConfig = resp.data.desiredConfig || resp.data.config || nextConfig;
      const commandId = resp.data.pendingCommandId || resp.data.commandId || "";
      const nextDevice = Object.assign({}, this.data.device, {
        config: savedConfig,
        desiredConfig: savedConfig,
        desiredConfigVersion: resp.data.desiredConfigVersion || this.data.device.desiredConfigVersion || 0,
        configState: resp.data.configState || "pending",
        pendingCommandId: commandId,
        status: resp.data.status || this.data.device.status,
        online: resp.data.online !== false,
        lastSyncedAt: resp.data.syncedAt || this.data.device.lastSyncedAt,
        updatedAt: Date.now(),
      });
      this.setData(Object.assign(buildDeviceState(nextDevice, feature, this.data), {
        commandBusy: true,
        activeCommandId: commandId,
        activeCommandKind: "config",
        commandDialogVisible: true,
        commandDialogTitle: "保存设置",
        commandDialogText: "已提交给服务器，等待设备接收",
        commandDialogStatus: "running",
        commandDialogProgress: 33,
        commandDialogColor: COMMAND_COLORS.running,
        commandDialogClosable: false,
        commandCountdownVisible: false,
        commandCountdownLeft: 0,
        commandCountdownTotal: 0,
      }));
      this.persistDevice(false);
      if (commandId) {
        this.scheduleCommandStatusPoll(commandId, { configCommand: true, feature });
      } else {
        this.failCommandBeforeAccepted("服务器未返回命令编号");
      }
    }).catch(() => {
      this.failCommandBeforeAccepted("保存失败，请检查网络");
    });
  },

  persistDevice(showToast) {
    const devices = getStoredDevices(this.data.phone);
    const updatedDevices = devices.map((item) => {
      if (item.id !== this.data.device.id) {
        return item;
      }
      const nextItem = Object.assign({}, item, this.data.device);
      const pin = normalizePin(this.data.device.blePin || item.blePin || getCachedBlePin(this.data.device.deviceNo));
      if (isValidPin(pin)) {
        nextItem.blePin = pin;
        setCachedBlePin(nextItem.deviceNo, pin);
      }
      cacheDeviceLocalFields(nextItem);
      return nextItem;
    });
    setStoredDevices(this.data.phone, updatedDevices);
    if (showToast) {
      wx.showToast({ title: "已保存" });
    }
  },

  promptBlePin(device) {
    return new Promise((resolve, reject) => {
      this.blePinResolve = resolve;
      this.blePinReject = reject;
      this.blePinPromptDevice = device;
      this.setData({
        blePinDialogVisible: true,
        blePinInput: "",
        blePinError: "",
      });
    });
  },

  onBlePinInput(e) {
    this.setData({ blePinInput: normalizePin(e.detail.value), blePinError: "" });
  },

  cancelBlePinDialog() {
    const reject = this.blePinReject;
    this.blePinResolve = null;
    this.blePinReject = null;
    this.blePinPromptDevice = null;
    this.setData({ blePinDialogVisible: false, blePinInput: "", blePinError: "" });
    if (reject) {
      reject(new Error("已取消蓝牙控制"));
    }
  },

  confirmBlePinDialog() {
    const pin = normalizePin(this.data.blePinInput);
    if (!isValidPin(pin)) {
      this.setData({ blePinError: "请输入设备标签上的 4-8 位数字 PIN" });
      return;
    }
    const resolve = this.blePinResolve;
    const device = this.blePinPromptDevice || this.data.device;
    const nextDevice = Object.assign({}, device, { blePin: pin });
    this.blePinResolve = null;
    this.blePinReject = null;
    this.blePinPromptDevice = null;
    setCachedBlePin(nextDevice.deviceNo, pin);
    this.setData({ device: nextDevice, blePinDialogVisible: false, blePinInput: "", blePinError: "" });
    this.persistDevice(false);
    if (resolve) {
      resolve(pin);
    }
  },

  ensureBlePin(device) {
    const pin = normalizePin((device && device.blePin) || getCachedBlePin(device && device.deviceNo));
    if (isValidPin(pin)) {
      if (!device.blePin) {
        const nextDevice = Object.assign({}, device, { blePin: pin });
        this.setData({ device: nextDevice });
        this.persistDevice(false);
      }
      return Promise.resolve(pin);
    }
    return this.promptBlePin(device);
  },

  openCommandDialog(kind, title, text) {
    this.setData({
      commandBusy: true,
      activeCommandKind: kind,
      commandDialogVisible: true,
      commandDialogTitle: title,
      commandDialogText: text || "正在提交命令",
      commandDialogStatus: "running",
      commandDialogProgress: 10,
      commandDialogColor: COMMAND_COLORS.running,
      commandDialogClosable: false,
      commandStep1Text: "已提交给服务器",
      commandStep2Text: "设备已接收",
      commandStep3Text: "设备已完成",
      commandCountdownVisible: false,
      commandCountdownLeft: 0,
      commandCountdownTotal: 0,
    });
  },

  updateCommandDialog(command, fallbackText) {
    const status = command && command.status ? command.status : "queued";
    const terminal = isTerminalCommandStatus(status);
    const dialogStatus = status === "succeeded" ? "success" : (terminal ? "failed" : "running");
    const updates = {
      commandDialogText: command ? commandStatusText(command) : fallbackText || "等待设备确认",
      commandDialogStatus: dialogStatus,
      commandDialogProgress: commandProgressForStatus(status, this.data.commandDialogProgress),
      commandDialogColor: status === "succeeded" ? COMMAND_COLORS.success : (terminal ? COMMAND_COLORS.failed : COMMAND_COLORS.running),
      commandDialogClosable: terminal,
    };
    if (terminal) {
      updates.commandDialogTitle = status === "succeeded" ? "执行成功" : "执行失败";
    }
    this.setData(updates);
  },

  closeCommandDialog() {
    if (!this.data.commandDialogClosable) {
      return;
    }
    this.setData({ commandDialogVisible: false });
  },

  finishCommandUi() {
    this.setData({
      commandBusy: false,
      activeCommandId: "",
      activeCommandKind: "",
      commandDialogClosable: true,
      commandCountdownVisible: false,
      commandCountdownLeft: 0,
      commandCountdownTotal: 0,
      manualRunning: false,
      manualLeft: 0,
      manualProgressPercent: 0,
    });
  },

  failCommandBeforeAccepted(message) {
    this.clearCommandPollTimer();
    this.setData({
      commandBusy: false,
      activeCommandId: "",
      activeCommandKind: "",
      commandDialogVisible: true,
      commandDialogTitle: "执行失败",
      commandDialogText: message || "命令提交失败，请重试",
      commandDialogStatus: "failed",
      commandDialogProgress: 0,
      commandDialogColor: COMMAND_COLORS.failed,
      commandDialogClosable: true,
      commandCountdownVisible: false,
      commandCountdownLeft: 0,
      commandCountdownTotal: 0,
      commandCountdownText: "",
    });
  },

  startManualWatering() {
    if (!this.ensureEditable()) {
      return;
    }

    if (this.data.commandBusy) {
      return;
    }

    const capabilities = this.data.device.capabilities || {};
    const rule = getParamRule(capabilities, "manualWatering", "durationSeconds");
    const duration = normalizeInteger(this.data.manualDuration, rule.min, rule.max);
    if (!duration) {
      wx.showToast({ title: `浇水秒数范围${rule.min}-${rule.max}`, icon: "none" });
      return;
    }
    setCachedManualDuration(this.data.device.deviceNo, duration);

    if (shouldUseBleControl(this.data.device)) {
      this.executeBleControlCommand({
        kind: "manualStart",
        title: "蓝牙浇水",
        commandType: "watering.manual.start",
        params: { durationSeconds: duration },
        duration,
      });
      return;
    }

    this.openCommandDialog("manualStart", "开始浇水", "正在提交手动浇水命令");
    callApi("watering.startManual", {
      phone: this.data.phone,
      deviceNo: this.data.device.deviceNo,
      durationSeconds: duration,
    }).then((resp) => {
      if (!resp || !resp.success || !resp.data) {
        this.failCommandBeforeAccepted(getResponseMessage(resp, "下发失败"));
        return;
      }

      this.clearManualTimer();
      const commandId = resp.data.commandId || resp.data.pendingCommandId || "";
      const nextDevice = Object.assign({}, this.data.device, {
        status: resp.data.status || this.data.device.status,
        online: resp.data.online !== false,
        updatedAt: Date.now(),
        syncState: commandId ? "queued" : this.data.device.syncState,
      });
      this.setData(Object.assign(buildDeviceState(nextDevice, "manualWatering", this.data), {
        manualDuration: String(duration),
        manualRunning: false,
        manualLeft: 0,
        manualTotal: duration,
        manualProgressPercent: 0,
        commandBusy: true,
        activeCommandId: commandId,
        activeCommandKind: "manualStart",
        commandDialogVisible: true,
        commandDialogTitle: "开始浇水",
        commandDialogText: "已提交给服务器，等待设备接收",
        commandDialogStatus: "running",
        commandDialogProgress: 33,
        commandDialogColor: COMMAND_COLORS.running,
        commandDialogClosable: false,
        commandCountdownVisible: false,
        commandCountdownLeft: 0,
        commandCountdownTotal: 0,
      }));
      this.persistDevice(false);
      if (commandId) {
        this.scheduleCommandStatusPoll(commandId, { manualStart: true, duration });
      } else {
        this.failCommandBeforeAccepted("服务器未返回命令编号");
      }
    }).catch(() => {
      this.failCommandBeforeAccepted("下发失败，请检查网络");
    });
  },

  stopManualWatering() {
    if (!this.ensureEditable() || this.data.commandBusy) {
      return;
    }
    if (shouldUseBleControl(this.data.device)) {
      this.executeBleControlCommand({
        kind: "manualStop",
        title: "蓝牙停止浇水",
        commandType: "watering.manual.stop",
        params: {},
      });
      return;
    }
    this.openCommandDialog("manualStop", "停止浇水", "正在提交停止命令");
    callApi("watering.stopManual", {
      phone: this.data.phone,
      deviceNo: this.data.device.deviceNo,
    }).then((resp) => {
      if (!resp || !resp.success || !resp.data) {
        this.failCommandBeforeAccepted(getResponseMessage(resp, "停止失败"));
        return;
      }

      const commandId = resp.data.commandId || resp.data.pendingCommandId || "";
      const nextDevice = Object.assign({}, this.data.device, {
        status: resp.data.status || this.data.device.status,
        online: resp.data.online !== false,
        updatedAt: Date.now(),
        syncState: commandId ? "queued" : this.data.device.syncState,
      });
      this.setData(Object.assign(buildDeviceState(nextDevice, "manualWatering", this.data), {
        manualDuration: this.data.manualDuration,
        manualRunning: this.data.manualRunning,
        manualLeft: this.data.manualLeft,
        manualTotal: this.data.manualTotal,
        manualProgressPercent: this.data.manualProgressPercent,
        commandBusy: true,
        activeCommandId: commandId,
        activeCommandKind: "manualStop",
        commandDialogVisible: true,
        commandDialogTitle: "停止浇水",
        commandDialogText: "已提交给服务器，等待设备接收",
        commandDialogStatus: "running",
        commandDialogProgress: 33,
        commandDialogColor: COMMAND_COLORS.running,
        commandDialogClosable: false,
        commandCountdownVisible: false,
        commandCountdownLeft: 0,
        commandCountdownTotal: 0,
      }));
      this.persistDevice(false);
      if (commandId) {
        this.scheduleCommandStatusPoll(commandId, { manualStop: true });
      } else {
        this.failCommandBeforeAccepted("服务器未返回命令编号");
      }
    }).catch(() => {
      this.failCommandBeforeAccepted("停止失败，请检查网络");
    });
  },

  openBleControlDialog(title, text) {
    this.setData({
      commandBusy: true,
      activeCommandKind: "bleControl",
      commandDialogVisible: true,
      commandDialogTitle: title || "蓝牙控制",
      commandDialogText: text || "正在扫描蓝牙设备",
      commandDialogStatus: "running",
      commandDialogProgress: 33,
      commandDialogColor: COMMAND_COLORS.running,
      commandDialogClosable: false,
      commandCountdownVisible: false,
      commandCountdownLeft: 0,
      commandCountdownTotal: 0,
      commandStep1Text: "扫描蓝牙设备",
      commandStep2Text: "将数据发送给设备",
      commandStep3Text: "最终结果",
    });
  },

  async executeBleControlCommand(options) {
    const device = this.data.device;
    let bleDevice = null;
    this.openBleControlDialog(options.title, "正在扫描蓝牙设备...");
    try {
      const blePin = await this.ensureBlePin(device);
      bleDevice = await this.scanBleControlDevice(device);
      this.setData({ commandDialogText: "已发现蓝牙设备，正在发送控制数据", commandDialogProgress: 66 });
      const cmdId = createBleCommandId();
      const payload = {
        type: "local.command",
        cmdId,
        deviceNo: device.deviceNo,
        commandType: options.commandType,
        ttlSeconds: options.ttlSeconds || 30,
        params: options.params || {},
        source: "ble",
        ts: Date.now(),
      };
      const frame = createBleSecureFrame({
        deviceNo: device.deviceNo,
        pin: blePin,
        msgType: "local.command",
        payload,
      });
      await this.sendBleControlPayload(bleDevice, frame, {
        cmdId,
        commandType: options.commandType,
        timeoutMs: getBleCommandAckTimeout(options),
        manualStart: options.kind === "manualStart",
        duration: options.duration,
      });
      this.finishBleControlSuccess(options);
    } catch (error) {
      this.clearCommandCountdownTimer();
      this.setData({
        commandBusy: false,
        commandDialogTitle: "执行失败",
        commandDialogText: (error && error.message) || "蓝牙控制失败，请靠近设备后重试",
        commandDialogStatus: "failed",
        commandDialogProgress: Math.max(10, Math.min(this.data.commandDialogProgress || 10, 66)),
        commandDialogColor: COMMAND_COLORS.failed,
        commandDialogClosable: true,
        commandCountdownVisible: false,
        commandCountdownLeft: 0,
        commandCountdownTotal: 0,
        commandCountdownText: "",
        manualRunning: false,
        manualLeft: 0,
        manualProgressPercent: 0,
      });
    } finally {
      if (bleDevice && bleDevice.deviceId) {
        this.closeBleControlConnection(bleDevice.deviceId);
      } else {
        this.cleanupBleControlNotify();
      }
    }
  },

  finishBleControlSuccess(options) {
    this.clearCommandCountdownTimer();
    const currentDevice = this.data.device || {};
    let nextDevice = Object.assign({}, currentDevice, { updatedAt: Date.now() });
    let preferredFeature = this.data.selectedFeature;
    let successText = options.successText || "设备已完成蓝牙本地控制命令";
    const extraState = {
      manualDuration: this.data.manualDuration,
      manualRunning: false,
      manualLeft: 0,
      manualTotal: this.data.manualTotal,
      manualProgressPercent: this.data.manualProgressPercent,
    };

    if (options.kind === "manualStart") {
      preferredFeature = "manualWatering";
      successText = options.successText || "浇水已完成，设备返回执行成功";
      nextDevice = Object.assign(nextDevice, {
        lastWateringAt: formatTime(new Date()),
        syncState: "succeeded",
      });
      extraState.manualDuration = String(options.duration || this.data.manualDuration || "");
      extraState.manualTotal = Number(options.duration || 0);
      extraState.manualProgressPercent = 100;
    } else if (options.kind === "manualStop") {
      preferredFeature = "manualWatering";
      successText = options.successText || "设备已停止浇水";
      extraState.manualTotal = 0;
      extraState.manualProgressPercent = 0;
    } else if (options.kind === "config") {
      const config = options.config || this.data.configDraft;
      preferredFeature = options.feature || this.data.selectedFeature;
      successText = options.successText || "设备已保存本地设置";
      nextDevice = Object.assign(nextDevice, {
        config,
        desiredConfig: config,
        appliedConfig: config,
        desiredConfigVersion: options.configVersion || currentDevice.desiredConfigVersion || 0,
        appliedConfigVersion: options.configVersion || currentDevice.appliedConfigVersion || 0,
        desiredConfigHash: options.configHash || currentDevice.desiredConfigHash || "",
        appliedConfigHash: options.configHash || currentDevice.appliedConfigHash || "",
        configState: "synced",
        pendingCommandId: "",
        lastSyncedAt: formatTime(new Date()),
      });
    }

    cacheDeviceLocalFields(nextDevice);
    this.setData(Object.assign(buildDeviceState(nextDevice, preferredFeature, this.data), extraState, {
      commandBusy: false,
      activeCommandId: "",
      activeCommandKind: "",
      commandDialogVisible: true,
      commandDialogTitle: "执行成功",
      commandDialogText: successText,
      commandDialogStatus: "success",
      commandDialogProgress: 100,
      commandDialogColor: COMMAND_COLORS.success,
      commandDialogClosable: true,
      commandCountdownVisible: false,
      commandCountdownLeft: 0,
      commandCountdownTotal: 0,
      commandCountdownText: "",
    }));
    this.persistDevice(false);
  },

  scanBleControlDevice(device) {
    return new Promise((resolve, reject) => {
      if (apiConfig.mode === "mock") {
        setTimeout(() => resolve({ deviceId: "mock-ble-control", name: `ytsh-${String((device && device.deviceSerial) || "device").toLowerCase()}` }), 500);
        return;
      }
      if (!wx.openBluetoothAdapter || !wx.startBluetoothDevicesDiscovery) {
        reject(new Error("当前设备不支持蓝牙控制"));
        return;
      }
      let finished = false;
      let timer = null;
      const serial = String((device && device.deviceSerial) || "").toLowerCase();
      const deviceNo = String((device && device.deviceNo) || "").toLowerCase();
      const finish = (error, result) => {
        if (finished) {
          return;
        }
        finished = true;
        if (timer) {
          clearTimeout(timer);
        }
        try {
          wx.stopBluetoothDevicesDiscovery({});
        } catch (ignore) {}
        try {
          wx.offBluetoothDeviceFound && wx.offBluetoothDeviceFound(handler);
        } catch (ignore) {}
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };
      const matchesDevice = (item) => {
        const name = String((item && (item.name || item.localName || getAdvertisedName(item.advertisData))) || "").toLowerCase();
        if (!name || name.indexOf("ytsh") !== 0) {
          return false;
        }
        return !serial || name.indexOf(serial) >= 0 || name.indexOf(deviceNo) >= 0;
      };
      const handler = (res) => {
        const devices = res.devices || [];
        const matched = devices.find((item) => matchesDevice(item));
        if (matched) {
          finish(null, matched);
        }
      };
      wx.openBluetoothAdapter({
        success: () => {
          wx.offBluetoothDeviceFound && wx.offBluetoothDeviceFound();
          wx.onBluetoothDeviceFound(handler);
          wx.startBluetoothDevicesDiscovery({
            allowDuplicatesKey: true,
            interval: 0,
            powerLevel: "high",
            success: () => {
              timer = setTimeout(() => finish(new Error("未扫描到蓝牙设备，请确认设备在附近并处于可连接状态")), BLE_CONTROL_SCAN_TIMEOUT_MS);
            },
            fail: () => finish(new Error("蓝牙扫描失败，请开启蓝牙后重试")),
          });
        },
        fail: () => finish(new Error("请先开启手机蓝牙")),
      });
    });
  },

  async sendBleControlPayload(bleDevice, payload, ackOptions) {
    if (apiConfig.mode === "mock") {
      await delay(500);
      return { type: "local.command.ack", status: "succeeded", code: "OK" };
    }
    const chunks = encodePayloadChunks(payload);
    await new Promise((resolve, reject) => {
      wx.createBLEConnection({
        deviceId: bleDevice.deviceId,
        timeout: 10000,
        success: resolve,
        fail: () => reject(new Error("蓝牙连接失败，请靠近设备后重试")),
      });
    });
    await this.setupBleControlNotify(bleDevice.deviceId);
    const ackPromise = this.waitForBleControlAck(ackOptions || {}, (ackOptions && ackOptions.timeoutMs) || BLE_CONTROL_ACK_TIMEOUT_MS);
    for (let index = 0; index < chunks.length; index += 1) {
      await new Promise((resolve, reject) => {
        wx.writeBLECharacteristicValue({
          deviceId: bleDevice.deviceId,
          serviceId: LOCAL_CONTROL_SERVICE_UUID,
          characteristicId: LOCAL_CONTROL_WRITE_UUID,
          value: chunks[index],
          success: resolve,
          fail: () => reject(new Error("蓝牙数据发送失败，请重试")),
        });
      });
      await delay(BLE_WRITE_CHUNK_DELAY_MS);
    }
    this.setData({ commandDialogText: "控制数据已发送，等待设备执行完成", commandDialogProgress: 85 });
    if (ackOptions && ackOptions.manualStart) {
      this.startManualCommandCountdown(ackOptions.duration);
    }
    return ackPromise;
  },

  setupBleControlNotify(deviceId) {
    if (!wx.notifyBLECharacteristicValueChange || !wx.onBLECharacteristicValueChange) {
      return Promise.reject(new Error("当前设备不支持蓝牙 ACK 回传"));
    }
    this.cleanupBleControlNotify();
    this.bleControlDeviceId = deviceId;
    this.bleControlTextBuffer = "";
    this.bleControlNotifyHandler = (res) => this.handleBleControlNotify(res);
    wx.onBLECharacteristicValueChange(this.bleControlNotifyHandler);
    return new Promise((resolve, reject) => {
      wx.notifyBLECharacteristicValueChange({
        deviceId,
        serviceId: LOCAL_CONTROL_SERVICE_UUID,
        characteristicId: LOCAL_CONTROL_NOTIFY_UUID,
        state: true,
        success: resolve,
        fail: () => reject(new Error("设备未开启蓝牙 ACK 回传")),
      });
    });
  },

  cleanupBleControlNotify() {
    if (this.bleControlAckTimer) {
      clearTimeout(this.bleControlAckTimer);
      this.bleControlAckTimer = null;
    }
    this.bleControlAckResolve = null;
    this.bleControlAckReject = null;
    this.bleControlAckOptions = null;
    if (this.bleControlNotifyHandler && wx.offBLECharacteristicValueChange) {
      try {
        wx.offBLECharacteristicValueChange(this.bleControlNotifyHandler);
      } catch (error) {}
    }
    this.bleControlNotifyHandler = null;
    this.bleControlTextBuffer = "";
    this.bleControlDeviceId = "";
  },

  waitForBleControlAck(options, timeoutMs) {
    return new Promise((resolve, reject) => {
      this.bleControlAckOptions = options || {};
      this.bleControlAckResolve = resolve;
      this.bleControlAckReject = reject;
      this.bleControlAckTimer = setTimeout(() => {
        this.bleControlAckTimer = null;
        this.bleControlAckResolve = null;
        this.bleControlAckReject = null;
        this.bleControlAckOptions = null;
        reject(new Error("等待设备执行完成超时"));
      }, timeoutMs);
    });
  },

  handleBleControlNotify(res) {
    if (this.bleControlDeviceId && res.deviceId && res.deviceId !== this.bleControlDeviceId) {
      return;
    }
    if (res.characteristicId && normalizeUuid(res.characteristicId) !== normalizeUuid(LOCAL_CONTROL_NOTIFY_UUID)) {
      return;
    }
    const text = bufferToText(res.value);
    if (!text) {
      return;
    }
    this.bleControlTextBuffer = `${this.bleControlTextBuffer || ""}${text}`;
    const parts = this.bleControlTextBuffer.split("\n");
    this.bleControlTextBuffer = parts.pop() || "";
    parts.forEach((part) => this.handleBleControlNotifyLine(part));

    const buffered = (this.bleControlTextBuffer || "").trim();
    if (buffered[0] === "{" && buffered[buffered.length - 1] === "}") {
      this.bleControlTextBuffer = "";
      this.handleBleControlNotifyLine(buffered);
    }
  },

  handleBleControlNotifyLine(line) {
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
    if (payload.type !== "local.command.ack") {
      return;
    }
    const options = this.bleControlAckOptions || {};
    if (options.cmdId && payload.cmdId !== options.cmdId) {
      return;
    }
    if (options.commandType && payload.commandType && payload.commandType !== options.commandType) {
      return;
    }
    const resolve = this.bleControlAckResolve;
    const reject = this.bleControlAckReject;
    const failed = isBleAckFailure(payload);
    const succeeded = isBleAckSuccess(payload);
    if (!failed && !succeeded) {
      this.setData({ commandDialogText: getBleAckMessage(payload, "设备正在执行命令，等待最终结果"), commandDialogProgress: Math.max(this.data.commandDialogProgress || 85, 90) });
      return;
    }
    if (this.bleControlAckTimer) {
      clearTimeout(this.bleControlAckTimer);
      this.bleControlAckTimer = null;
    }
    this.bleControlAckResolve = null;
    this.bleControlAckReject = null;
    this.bleControlAckOptions = null;
    if (failed) {
      if (reject) {
        reject(new Error(getBleAckMessage(payload, "设备执行失败")));
      }
      return;
    }
    if (resolve) {
      resolve(payload);
    }
  },

  closeBleControlConnection(deviceId) {
    this.cleanupBleControlNotify();
    if (!deviceId || !wx.closeBLEConnection) {
      return;
    }
    try {
      wx.closeBLEConnection({ deviceId });
    } catch (error) {}
  },

  scheduleCommandStatusPoll(commandId, options) {
    if (!commandId) {
      return;
    }
    this.clearCommandPollTimer();
    const maxAttempts = options && options.manualStart
      ? Math.max(12, Math.ceil((Number(options.duration || 0) + 15) / 2) + 5)
      : ((options && options.maxAttempts) || 40);
    const poll = (attempt) => {
      callApi("device.getCommandStatus", {
        phone: this.data.phone,
        deviceNo: this.data.device.deviceNo,
        commandId,
      }).then((resp) => {
        const command = resp && resp.success && resp.data ? resp.data.command : null;
        if (!command) {
          if (attempt >= maxAttempts) {
            this.failCommandTimeout("查询执行结果超时，执行失败");
          }
          return;
        }

        this.updateCommandDialog(command);
        if (options && options.manualStart && (command.status === "received" || command.status === "executing")) {
          this.startManualCommandCountdown(options.duration);
        }

        if (command.status === "succeeded") {
          this.clearCommandPollTimer();
          this.clearCommandCountdownTimer();
          this.updateCommandDialog(command);
          this.finishCommandUi();
          this.refreshDeviceStatus(false);
          return;
        }
        if (command.status === "failed" || command.status === "expired" || command.status === "delivery_timeout" || command.status === "execution_timeout" || command.status === "publish_failed") {
          this.clearCommandPollTimer();
          this.clearCommandCountdownTimer();
          this.updateCommandDialog(command);
          this.finishCommandUi();
          this.refreshDeviceStatus(false);
          return;
        }
        if (attempt < maxAttempts) {
          this.commandPollTimer = setTimeout(() => poll(attempt + 1), 2000);
        } else {
          this.failCommandTimeout("等待设备执行超时，执行失败");
        }
      }).catch(() => {
        if (attempt < maxAttempts) {
          this.commandPollTimer = setTimeout(() => poll(attempt + 1), 2000);
        } else {
          this.failCommandTimeout("查询执行结果超时，执行失败");
        }
      });
    };
    this.commandPollTimer = setTimeout(() => poll(1), 800);
  },

  startManualCommandCountdown(duration) {
    const safeDuration = Number(duration || this.data.manualTotal || 0);
    if (!safeDuration) {
      return;
    }
    const timeoutTotal = safeDuration + 10;
    if (this.data.commandCountdownVisible && this.data.commandCountdownTotal === timeoutTotal) {
      return;
    }
    this.clearCommandCountdownTimer();
    this.commandCountdownElapsed = 0;
    this.setData({
      commandCountdownVisible: true,
      commandCountdownLeft: safeDuration,
      commandCountdownTotal: timeoutTotal,
      commandCountdownText: `浇水倒计时，剩余 ${safeDuration} 秒`,
      commandDialogText: "设备已接收命令，等待完成",
      commandDialogProgress: 66,
      commandDialogColor: COMMAND_COLORS.running,
      commandDialogStatus: "running",
      manualRunning: false,
      manualLeft: 0,
      manualTotal: safeDuration,
      manualProgressPercent: 0,
    });
    this.commandCountdownTimer = setInterval(() => {
      this.commandCountdownElapsed += 1;
      if (this.commandCountdownElapsed >= timeoutTotal) {
        this.failCommandTimeout("等待设备完成超时，执行失败");
        return;
      }
      const nextLeft = Math.max(0, safeDuration - this.commandCountdownElapsed);
      const timeoutLeft = Math.max(0, timeoutTotal - this.commandCountdownElapsed);
      const commandCountdownText = nextLeft > 0
        ? `浇水倒计时，剩余 ${nextLeft} 秒`
        : `浇水时间已到，正在查询执行结果（${timeoutLeft} 秒超时）`;
      this.setData({ commandCountdownLeft: nextLeft, commandCountdownText });
    }, 1000);
  },

  failCommandTimeout(message) {
    this.clearCommandPollTimer();
    this.clearCommandCountdownTimer();
    const currentProgress = Number(this.data.commandDialogProgress || 33);
    const failedProgress = Math.max(0, Math.min(currentProgress, 66));
    this.setData({
      commandBusy: false,
      activeCommandId: "",
      activeCommandKind: "",
      commandDialogVisible: true,
      commandDialogTitle: "执行失败",
      commandDialogText: message || "命令执行失败",
      commandDialogStatus: "failed",
      commandDialogProgress: failedProgress,
      commandDialogColor: COMMAND_COLORS.failed,
      commandDialogClosable: true,
      commandCountdownVisible: false,
      commandCountdownLeft: 0,
      commandCountdownTotal: 0,
      commandCountdownText: "",
      manualRunning: false,
      manualLeft: 0,
      manualProgressPercent: 0,
    });
    this.refreshDeviceStatus(false);
  },

  beginManualCountdown(duration) {
    const safeDuration = Number(duration || this.data.manualTotal || 0);
    if (!safeDuration) {
      return;
    }
    this.clearManualTimer();
    const nextDevice = Object.assign({}, this.data.device, {
      status: "浇水中",
      lastWateringAt: formatTime(new Date()),
      updatedAt: Date.now(),
      syncState: "succeeded",
    });
    this.setData(Object.assign(buildDeviceState(nextDevice, "manualWatering"), {
      manualDuration: String(safeDuration),
      manualRunning: true,
      manualLeft: safeDuration,
      manualTotal: safeDuration,
      manualProgressPercent: 0,
    }));
    this.persistDevice(false);
    this.manualTimer = setInterval(() => {
      const nextLeft = this.data.manualLeft - 1;
      const total = this.data.manualTotal || safeDuration;
      if (nextLeft <= 0) {
        this.finishManualWatering();
        return;
      }
      this.setData({
        manualLeft: nextLeft,
        manualProgressPercent: Math.round(((total - nextLeft) * 100) / total),
      });
    }, 1000);
  },

  finishManualWatering() {
    this.finishManualStopUi("浇水完成", 100);
    this.refreshDeviceStatus(false);
  },

  finishManualStopUi(toastTitle, progressPercent) {
    this.clearManualTimer();
    const nextDevice = Object.assign({}, this.data.device, {
      status: "在线",
      updatedAt: Date.now(),
      syncState: "succeeded",
    });
    this.setData(Object.assign(buildDeviceState(nextDevice, "manualWatering"), {
      manualDuration: this.data.manualDuration,
      manualRunning: false,
      manualLeft: 0,
      manualTotal: 0,
      manualProgressPercent: progressPercent === undefined ? 0 : progressPercent,
    }));
    this.persistDevice(false);
    if (toastTitle) {
      wx.showToast({ title: toastTitle });
    }
  },

  clearManualTimer() {
    if (this.manualTimer) {
      clearInterval(this.manualTimer);
      this.manualTimer = null;
    }
  },

  clearCommandPollTimer() {
    if (this.commandPollTimer) {
      clearTimeout(this.commandPollTimer);
      this.commandPollTimer = null;
    }
  },

  clearCommandCountdownTimer() {
    if (this.commandCountdownTimer) {
      clearInterval(this.commandCountdownTimer);
      this.commandCountdownTimer = null;
    }
  },
});