const SESSION_KEY = "yuntingSession";
const DEVICES_KEY_PREFIX = "yuntingDevices";
const BLE_PIN_KEY_PREFIX = "yuntingBlePin";
const DEVICE_LOCAL_STATE_KEY_PREFIX = "yuntingDeviceLocalState";
const { callApi } = require("../../services/apiClient");

const DEVICE_TYPES = [
  { label: "智能浇水设备", value: "watering", code: "AW" },
  { label: "环境传感器", value: "sensor", code: "ES" },
  { label: "智能灯控", value: "light", code: "LC" },
  { label: "智能插座", value: "socket", code: "SP" },
  { label: "智能网关", value: "gateway", code: "GW" },
];

const FILTERS = [
  { label: "全部", value: "all" },
  { label: "智能浇水", value: "watering" },
  { label: "传感器", value: "sensor" },
  { label: "灯控", value: "light" },
  { label: "插座", value: "socket" },
  { label: "网关", value: "gateway" },
];

const DEVICE_NO_PATTERN = /^YT-([A-Z]{2})-([0-9A-F]{5})-([0-9A-F]{4})$/;
const DEVICE_PIN_PATTERN = /^\d{4,8}$/;
const DEVICE_CODE_SALT = "YUNTING-ZHIJIA-DEVICE-CODE-V1";
const CRC32_TABLE = createCrc32Table();
const DEVICE_NO_ERROR = "设备号不正确";
const DEVICE_ALREADY_BOUND_ERROR = "该设备已经是你的设备，可在设备管理中查看";

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

function maskPhone(phone) {
  return String(phone || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function extractDeviceNo(text) {
  const matched = normalizeDeviceNo(text).match(/YT-[A-Z]{2}-[0-9A-F]{5}-[0-9A-F]{4}/);
  return matched ? matched[0] : "";
}

function normalizePin(value) {
  return String(value || "").trim();
}

function extractDevicePin(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const parsed = JSON.parse(raw);
    const pin = normalizePin(parsed.pin || parsed.devicePin || parsed.device_pin);
    if (pin) {
      return pin;
    }
  } catch (error) {}
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (error) {}
  const queryMatch = decoded.match(/(?:^|[?&#])(?:pin|devicePin|device_pin)=([0-9]{4,8})(?:$|[&#])/i);
  if (queryMatch) {
    return queryMatch[1];
  }
  const textMatch = decoded.match(/(?:^|\b)(?:PIN|pin|设备PIN|设备 Pin)\s*[:=：]\s*([0-9]{4,8})(?:\b|$)/);
  return textMatch ? textMatch[1] : "";
}

function getDeviceTypeByCode(code) {
  return DEVICE_TYPES.find((item) => item.code === code);
}

function parseDeviceNo(value) {
  const deviceNo = normalizeDeviceNo(value);
  const matched = deviceNo.match(DEVICE_NO_PATTERN);
  if (!matched) {
    return {
      valid: false,
      message: DEVICE_NO_ERROR,
    };
  }

  const typeCode = matched[1];
  const serial = matched[2];
  const checkCode = matched[3];
  const body = `YT-${typeCode}-${serial}`;
  const expectedCheckCode = getCheckCode(body);
  if (checkCode !== expectedCheckCode) {
    return {
      valid: false,
      message: DEVICE_NO_ERROR,
    };
  }

  const deviceType = getDeviceTypeByCode(typeCode);
  if (!deviceType) {
    return {
      valid: false,
      message: DEVICE_NO_ERROR,
    };
  }

  return {
    valid: true,
    deviceNo,
    typeCode,
    serial,
    deviceType,
  };
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

function getBlePinKey(deviceNo) {
  return `${BLE_PIN_KEY_PREFIX}_${deviceNo || "unknown"}`;
}

function getCachedBlePin(deviceNo) {
  return normalizePin(wx.getStorageSync(getBlePinKey(deviceNo)) || "");
}

function setCachedBlePin(deviceNo, pin) {
  const normalized = normalizePin(pin);
  if (deviceNo && DEVICE_PIN_PATTERN.test(normalized)) {
    wx.setStorageSync(getBlePinKey(deviceNo), normalized);
  }
}

function getDeviceLocalStateKey(deviceNo) {
  return `${DEVICE_LOCAL_STATE_KEY_PREFIX}_${deviceNo || "unknown"}`;
}

function getCachedDeviceLocalState(deviceNo) {
  const state = wx.getStorageSync(getDeviceLocalStateKey(deviceNo));
  return state && typeof state === "object" ? state : {};
}

function hasConfigContent(config) {
  return !!(
    config && typeof config === "object" && (
      config.automationMode
      || (Array.isArray(config.enabledFeatures) && config.enabledFeatures.length)
      || (config.features && typeof config.features === "object" && Object.keys(config.features).length)
    )
  );
}

function isDeviceProvisioned(device) {
  return !(device && (device.provisioned === false || device.provisionState === "not_provisioned" || device.networkState === "not_provisioned" || device.status === "未入网"));
}

function isDeviceOnline(device) {
  return !!(device && isDeviceProvisioned(device) && device.online !== false && device.status !== "离线");
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

function mergeLocalBlePins(remoteDevices, localDevices) {
  const pinByDeviceNo = {};
  (localDevices || []).forEach((item) => {
    const pin = normalizePin(item && item.blePin);
    if (item && item.deviceNo && DEVICE_PIN_PATTERN.test(pin)) {
      pinByDeviceNo[item.deviceNo] = pin;
      setCachedBlePin(item.deviceNo, pin);
    }
  });
  return (remoteDevices || []).map((item) => {
    const pin = pinByDeviceNo[item.deviceNo] || getCachedBlePin(item.deviceNo);
    const withPin = DEVICE_PIN_PATTERN.test(pin) ? Object.assign({}, item, { blePin: pin }) : item;
    return mergeLocalDeviceState(withPin);
  });
}

function unbindDeviceRemote(phone, deviceNo) {
  return callApi("device.unbind", { phone, deviceNo });
}

Page({
  data: {
    phone: "",
    phoneMasked: "",
    devices: [],
    visibleDevices: [],
    filters: FILTERS,
    activeFilter: "all",
    deviceNo: "",
    devicePin: "",
    deviceName: "",
    deviceCount: 0,
    onlineCount: 0,
  },

  onLoad() {
    this.ensureLogin();
  },

  onShow() {
    if (this.ensureLogin()) {
      this.loadDevices();
    }
  },

  ensureLogin() {
    const session = wx.getStorageSync(SESSION_KEY);
    if (!session || !session.phone) {
      wx.redirectTo({ url: "/pages/index/index" });
      return false;
    }
    this.setData({ phone: session.phone, phoneMasked: maskPhone(session.phone) });
    return true;
  },

  async loadDevices() {
    let devices = getStoredDevices(this.data.phone).map((item) => mergeLocalDeviceState(item));
    try {
      const resp = await callApi("device.list", { phone: this.data.phone });
      if (resp && resp.success && resp.data && Array.isArray(resp.data.devices)) {
        devices = mergeLocalBlePins(resp.data.devices, devices);
        setStoredDevices(this.data.phone, devices);
      }
    } catch (error) {}

    const onlineCount = devices.filter((item) => item.online !== false && item.status !== "离线" && item.status !== "未入网" && item.networkState !== "not_provisioned").length;
    this.setData({
      devices,
      deviceCount: devices.length,
      onlineCount,
    });
    this.applyFilter();
  },

  applyFilter() {
    const { devices, activeFilter } = this.data;
    const visibleDevices = activeFilter === "all"
      ? devices
      : devices.filter((item) => item.type === activeFilter);
    this.setData({ visibleDevices });
  },

  onFilterTap(e) {
    this.setData({ activeFilter: e.currentTarget.dataset.value }, this.applyFilter);
  },

  onDeviceNoInput(e) {
    this.setData({ deviceNo: normalizeDeviceNo(e.detail.value) });
  },

  onDevicePinInput(e) {
    this.setData({ devicePin: normalizePin(e.detail.value) });
  },

  onDeviceNameInput(e) {
    this.setData({ deviceName: e.detail.value.trim() });
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

        const devicePin = extractDevicePin(res.result);
        this.setData({
          deviceNo: parsed.deviceNo,
          devicePin,
        });
        wx.showToast({ title: devicePin ? "已读取设备号和 PIN" : "已读取设备号" });
      },
    });
  },

  configureDevice() {
    const { deviceNo, deviceName } = this.data;
    const parsed = parseDeviceNo(deviceNo);
    if (!parsed.valid) {
      wx.showToast({ title: parsed.message, icon: "none" });
      return;
    }

    if (!deviceName) {
      wx.showToast({ title: "请输入设备名称", icon: "none" });
      return;
    }

    if (!DEVICE_PIN_PATTERN.test(normalizePin(this.data.devicePin))) {
      wx.showToast({ title: "请输入设备 PIN", icon: "none" });
      return;
    }

    const devices = getStoredDevices(this.data.phone);
    const existingDevice = devices.find((item) => item.deviceNo === parsed.deviceNo);
    if (existingDevice && existingDevice.provisionState !== "not_provisioned" && existingDevice.networkState !== "not_provisioned" && existingDevice.provisioned !== false) {
      wx.showModal({ title: "设备已存在", content: DEVICE_ALREADY_BOUND_ERROR, showCancel: false });
      return;
    }

    const target = `/pages/configure/index?deviceNo=${encodeURIComponent(parsed.deviceNo)}&pin=${encodeURIComponent(this.data.devicePin)}&deviceName=${encodeURIComponent(deviceName)}`;
    wx.navigateTo({ url: target });
  },

  configureStoredDevice(e) {
    const id = e.currentTarget.dataset.id;
    const device = getStoredDevices(this.data.phone).find((item) => item.id === id);
    if (!device) {
      wx.showToast({ title: "设备不存在", icon: "none" });
      return;
    }
    const pin = normalizePin(device.blePin || getCachedBlePin(device.deviceNo));
    const pinQuery = DEVICE_PIN_PATTERN.test(pin) ? `&pin=${encodeURIComponent(pin)}` : "";
    const target = `/pages/configure/index?deviceNo=${encodeURIComponent(device.deviceNo)}&deviceName=${encodeURIComponent(device.name || "")}${pinQuery}`;
    wx.navigateTo({ url: target });
  },

  openDevice(e) {
    wx.navigateTo({ url: `/pages/device/index?id=${e.currentTarget.dataset.id}` });
  },

  deleteDevice(e) {
    const id = e.currentTarget.dataset.id;
    const device = getStoredDevices(this.data.phone).find((item) => item.id === id);
    if (!device) {
      wx.showToast({ title: "设备不存在", icon: "none" });
      return;
    }

    wx.showModal({
      title: "解除绑定",
      content: "解除绑定后，该设备会从当前账号移除。如需让其他账号重新配置，请在设备端恢复出厂设置或重新进入配网模式，确定解除绑定吗？",
      confirmText: "解除绑定",
      confirmColor: "#c2573d",
      success: async (res) => {
        if (!res.confirm) {
          return;
        }

        wx.showLoading({ title: "解绑中..." });
        let unbindResp = null;
        try {
          unbindResp = await unbindDeviceRemote(this.data.phone, device.deviceNo);
        } catch (error) {
          unbindResp = null;
        }
        wx.hideLoading();

        if (!unbindResp || !unbindResp.success) {
          wx.showToast({ title: (unbindResp && unbindResp.message) || "解绑失败", icon: "none" });
          return;
        }

        const devices = getStoredDevices(this.data.phone).filter((item) => item.id !== id);
        setStoredDevices(this.data.phone, devices);
        this.loadDevices();
        wx.showModal({
          title: "已解绑",
          content: "设备已从当前账号移除。若要重新配置或给其他账号使用，请先在设备端恢复出厂设置或重新进入配网模式。",
          showCancel: false,
        });
      },
    });
  },

  openAbout() {
    wx.navigateTo({ url: "/pages/about/index" });
  },

  logout() {
    wx.removeStorageSync(SESSION_KEY);
    wx.redirectTo({ url: "/pages/index/index" });
  },
});