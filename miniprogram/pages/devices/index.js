const SESSION_KEY = "yuntingSession";
const DEVICES_KEY_PREFIX = "yuntingDevices";

const DEVICE_TYPES = [
  { label: "自动浇水系统", value: "watering" },
  { label: "环境传感器", value: "sensor" },
  { label: "智能灯控", value: "light" },
  { label: "智能插座", value: "socket" },
];

const FILTERS = [
  { label: "全部", value: "all" },
  { label: "自动浇水", value: "watering" },
  { label: "传感器", value: "sensor" },
  { label: "灯控", value: "light" },
  { label: "插座", value: "socket" },
];

function createWateringConfig() {
  return {
    mode: "demand",
    demand: {
      intervalHours: 4,
      threshold: 35,
      durationSeconds: 20,
    },
    schedule: {
      timesPerDay: 2,
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

function getDevicesKey(phone) {
  return `${DEVICES_KEY_PREFIX}_${phone}`;
}

function getStoredDevices(phone) {
  return wx.getStorageSync(getDevicesKey(phone)) || [];
}

function setStoredDevices(phone, devices) {
  wx.setStorageSync(getDevicesKey(phone), devices);
}

Page({
  data: {
    phone: "",
    devices: [],
    visibleDevices: [],
    filters: FILTERS,
    activeFilter: "all",
    deviceTypes: DEVICE_TYPES,
    deviceTypeIndex: 0,
    deviceNo: "",
    deviceName: "",
    deviceCount: 0,
    wateringCount: 0,
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
    this.setData({ phone: session.phone });
    return true;
  },

  loadDevices() {
    const devices = getStoredDevices(this.data.phone);
    const wateringCount = devices.filter((item) => item.type === "watering").length;
    this.setData({
      devices,
      deviceCount: devices.length,
      wateringCount,
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
    this.setData({ deviceNo: e.detail.value.trim() });
  },

  onDeviceNameInput(e) {
    this.setData({ deviceName: e.detail.value.trim() });
  },

  bindDevice() {
    const { deviceNo, deviceName, deviceTypeIndex, deviceTypes } = this.data;
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(deviceNo)) {
      wx.showToast({ title: "设备号格式不正确", icon: "none" });
      return;
    }

    const devices = getStoredDevices(this.data.phone);
    if (devices.some((item) => item.deviceNo === deviceNo)) {
      wx.showToast({ title: "设备已绑定", icon: "none" });
      return;
    }

    const selectedType = deviceTypes[deviceTypeIndex];
    const now = Date.now();
    const device = {
      id: `device_${now}`,
      deviceNo,
      name: deviceName || selectedType.label,
      ownerPhone: this.data.phone,
      type: selectedType.value,
      typeLabel: getDeviceTypeLabel(selectedType.value),
      status: "在线",
      createdAt: now,
      updatedAt: now,
      lastWateringAt: "--",
      config: selectedType.value === "watering" ? createWateringConfig() : {},
    };

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
    wx.showModal({
      title: "解绑设备",
      content: "确定解绑这台设备吗？",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const devices = getStoredDevices(this.data.phone).filter((item) => item.id !== id);
        setStoredDevices(this.data.phone, devices);
        wx.showToast({ title: "已解绑" });
        this.loadDevices();
      },
    });
  },

  logout() {
    wx.removeStorageSync(SESSION_KEY);
    wx.redirectTo({ url: "/pages/index/index" });
  },
});