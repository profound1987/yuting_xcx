const SESSION_KEY = "yuntingSession";
const DEVICES_KEY_PREFIX = "yuntingDevices";
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
const DEVICE_CODE_SALT = "YUNTING-ZHIJIA-DEVICE-CODE-V1";
const CRC32_TABLE = createCrc32Table();
const DEVICE_NO_ERROR = "设备号不正确";
const DEVICE_ALREADY_BOUND_ERROR = "设备已被绑定";

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

function getDeviceTypeLabel(type) {
  const matched = DEVICE_TYPES.find((item) => item.value === type);
  return matched ? matched.label : "未知设备";
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

function bindDeviceRemote(phone, deviceNo, deviceName) {
  return callApi("device.bind", { phone, deviceNo, deviceName });
}

function unbindDeviceRemote(phone, deviceNo) {
  return callApi("device.unbind", { phone, deviceNo });
}

function getBindErrorMessage(resp) {
  if (resp && resp.message) {
    return resp.message;
  }
  if (resp && resp.code === "DEVICE_ALREADY_BOUND") {
    return DEVICE_ALREADY_BOUND_ERROR;
  }
  return DEVICE_NO_ERROR;
}

function showBindError(resp) {
  const message = getBindErrorMessage(resp);
  const isRiskMessage = resp && (resp.code === "DEVICE_BIND_LOCKED" || (resp.data && resp.data.bindRisk));
  if (isRiskMessage || message.length > 12) {
    wx.showModal({ title: "绑定失败", content: message, showCancel: false });
    return;
  }
  wx.showToast({ title: message, icon: "none" });
}

function createDeviceFromRemote(parsed, selectedType, deviceName, remoteDevice) {
  const now = Date.now();
  const device = remoteDevice || {};
  const type = device.type || selectedType.value;
  return {
    id: device.id || `device_${now}`,
    deviceNo: parsed.deviceNo,
    deviceSerial: device.deviceSerial || parsed.serial,
    deviceTypeCode: device.deviceTypeCode || parsed.typeCode,
    name: device.name || deviceName || selectedType.label,
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
    syncState: device.syncState || (device.online === false ? "offline" : "synced"),
    config: type === "watering" ? (device.config || createWateringConfig()) : (device.config || {}),
  };
}

Page({
  data: {
    phone: "",
    phoneMasked: "",
    devices: [],
    visibleDevices: [],
    filters: FILTERS,
    activeFilter: "all",
    deviceTypes: DEVICE_TYPES,
    deviceTypeIndex: 0,
    deviceNo: "",
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

  loadDevices() {
    const devices = getStoredDevices(this.data.phone);
    const onlineCount = devices.filter((item) => item.online !== false && item.status !== "离线").length;
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

  onTypeChange(e) {
    this.setData({ deviceTypeIndex: Number(e.detail.value) });
  },

  onDeviceNoInput(e) {
    this.setData({ deviceNo: normalizeDeviceNo(e.detail.value) });
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

        const deviceTypeIndex = this.data.deviceTypes.findIndex((item) => item.code === parsed.typeCode);
        this.setData({
          deviceNo: parsed.deviceNo,
          deviceTypeIndex: deviceTypeIndex >= 0 ? deviceTypeIndex : this.data.deviceTypeIndex,
        });
        wx.showToast({ title: "已读取设备号" });
      },
    });
  },

  async bindDevice() {
    const { deviceNo, deviceName, deviceTypeIndex, deviceTypes } = this.data;
    const parsed = parseDeviceNo(deviceNo);
    if (!parsed.valid) {
      wx.showToast({ title: parsed.message, icon: "none" });
      return;
    }

    const devices = getStoredDevices(this.data.phone);
    if (devices.some((item) => item.deviceNo === parsed.deviceNo)) {
      wx.showToast({ title: DEVICE_ALREADY_BOUND_ERROR, icon: "none" });
      return;
    }

    wx.showLoading({ title: "绑定中..." });
    let bindResp = null;
    try {
      bindResp = await bindDeviceRemote(this.data.phone, parsed.deviceNo, deviceName);
    } catch (error) {
      bindResp = null;
    }
    wx.hideLoading();

    if (!bindResp || !bindResp.success || !bindResp.data || !bindResp.data.device) {
      showBindError(bindResp);
      return;
    }

    const selectedType = parsed.deviceType || deviceTypes[deviceTypeIndex];
    const device = createDeviceFromRemote(parsed, selectedType, deviceName, bindResp.data.device);
    device.ownerPhone = this.data.phone;

    devices.unshift(device);
    setStoredDevices(this.data.phone, devices);
    this.setData({ deviceNo: "", deviceName: "", deviceTypeIndex: 0 });
    wx.showToast({ title: "绑定成功" });
    this.loadDevices();
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
      content: "解除绑定后，该设备的配置和本地数据会从当前账号删除，确定解除绑定吗？",
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
        wx.showToast({ title: "已解绑" });
        this.loadDevices();
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