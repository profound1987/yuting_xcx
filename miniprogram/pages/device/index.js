const SESSION_KEY = "yuntingSession";
const DEVICES_KEY_PREFIX = "yuntingDevices";
const { callApi } = require("../../services/apiClient");

const MODE_LABELS = {
  demand: "按需浇水",
  schedule: "定期浇水",
  manual: "手动浇水",
};

const MODE_TABS = [
  { label: "按需", value: "demand" },
  { label: "定期", value: "schedule" },
  { label: "手动", value: "manual" },
];

function getDevicesKey(phone) {
  return `${DEVICES_KEY_PREFIX}_${phone}`;
}

function getStoredDevices(phone) {
  return wx.getStorageSync(getDevicesKey(phone)) || [];
}

function setStoredDevices(phone, devices) {
  wx.setStorageSync(getDevicesKey(phone), devices);
}

function formatTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

function normalizeWateringConfig(config) {
  const nextConfig = config || {};
  nextConfig.mode = nextConfig.mode || "demand";
  nextConfig.demand = nextConfig.demand || {};
  nextConfig.schedule = nextConfig.schedule || {};
  nextConfig.manual = nextConfig.manual || {};

  nextConfig.demand.intervalHours = nextConfig.demand.intervalHours || 4;
  nextConfig.demand.threshold = nextConfig.demand.threshold || 35;
  nextConfig.demand.durationSeconds = nextConfig.demand.durationSeconds || 20;
  nextConfig.schedule.intervalDays = nextConfig.schedule.intervalDays || 1;
  nextConfig.schedule.times = nextConfig.schedule.times || 2;
  nextConfig.schedule.durationSeconds = nextConfig.schedule.durationSeconds || 30;
  nextConfig.manual.durationSeconds = nextConfig.manual.durationSeconds || 10;

  return nextConfig;
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config || {}));
}

function isDeviceOnline(device) {
  return !!(device && device.online !== false && device.status !== "离线");
}

function getSyncText(device) {
  if (!isDeviceOnline(device)) {
    return "离线只读";
  }
  if (device && device.lastSyncedAt) {
    return "已同步";
  }
  return "在线可同步";
}

function getResponseMessage(resp, fallback) {
  return (resp && resp.message) || fallback;
}

function shouldUseRemoteConfig(localDevice, statusData) {
  const localSyncedAt = Number(localDevice && localDevice.lastSyncedAt ? localDevice.lastSyncedAt : 0);
  const remoteSyncedAt = Number(statusData && statusData.lastSyncedAt ? statusData.lastSyncedAt : 0);
  return !localSyncedAt || remoteSyncedAt >= localSyncedAt;
}

Page({
  data: {
    deviceId: "",
    phone: "",
    device: null,
    modeTabs: MODE_TABS,
    modeText: "按需浇水",
    manualRunning: false,
    manualLeft: 0,
    canEdit: false,
    syncText: "",
    syncing: false,
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
  },

  loadDevice(id) {
    const devices = getStoredDevices(this.data.phone);
    const device = devices.find((item) => item.id === id);
    if (!device) {
      wx.showToast({ title: "设备不存在", icon: "none" });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    if (device.type === "watering") {
      device.config = normalizeWateringConfig(device.config);
    }
    this.setData({
      device,
      modeText: (device.config && MODE_LABELS[device.config.mode]) || "设备管理",
      canEdit: isDeviceOnline(device),
      syncText: getSyncText(device),
    });
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
      const nextDevice = Object.assign({}, this.data.device, {
        status: statusData.status || this.data.device.status,
        online: statusData.online !== false,
        lastWateringAt: statusData.lastWateringAt || this.data.device.lastWateringAt,
        lastSyncedAt: statusData.lastSyncedAt || this.data.device.lastSyncedAt,
        updatedAt: statusData.updatedAt || this.data.device.updatedAt,
      });

      if (nextDevice.type === "watering" && statusData.config && shouldUseRemoteConfig(this.data.device, statusData)) {
        nextDevice.config = normalizeWateringConfig(statusData.config);
      }

      this.setData({
        device: nextDevice,
        modeText: (nextDevice.config && MODE_LABELS[nextDevice.config.mode]) || "设备管理",
        canEdit: isDeviceOnline(nextDevice),
        syncText: getSyncText(nextDevice),
      });
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
      wx.showToast({ title: "设备离线，无法编辑", icon: "none" });
      return false;
    }
    return true;
  },

  selectMode(e) {
    if (!this.ensureEditable() || this.data.manualRunning) {
      return;
    }
    const mode = e.currentTarget.dataset.mode;
    this.setData({
      "device.config.mode": mode,
      modeText: MODE_LABELS[mode],
    });
  },

  onNumberInput(e) {
    if (!this.data.canEdit) {
      return;
    }
    const { section, field } = e.currentTarget.dataset;
    const key = `device.config.${section}.${field}`;
    this.setData({ [key]: e.detail.value });
  },

  saveConfig() {
    if (!this.ensureEditable()) {
      return;
    }

    if (this.data.manualRunning) {
      wx.showToast({ title: "浇水中，稍后保存", icon: "none" });
      return;
    }

    const device = this.data.device;
    const config = device.config;
    const demandInterval = normalizeInteger(config.demand.intervalHours, 1, 72);
    const demandThreshold = normalizeInteger(config.demand.threshold, 1, 100);
    const demandDuration = normalizeInteger(config.demand.durationSeconds, 1, 3600);
    const scheduleIntervalDays = normalizeInteger(config.schedule.intervalDays, 1, 365);
    const scheduleTimes = normalizeInteger(config.schedule.times, 1, 24);
    const scheduleDuration = normalizeInteger(config.schedule.durationSeconds, 1, 3600);
    const manualDuration = normalizeInteger(config.manual.durationSeconds, 1, 3600);

    if (!scheduleIntervalDays) {
      wx.showToast({ title: "天数须为整数", icon: "none" });
      return;
    }

    if (!scheduleTimes) {
      wx.showToast({ title: "次数须为整数", icon: "none" });
      return;
    }

    if (!demandInterval || !demandThreshold || !demandDuration || !scheduleIntervalDays || !scheduleTimes || !scheduleDuration || !manualDuration) {
      wx.showToast({ title: "请输入有效整数", icon: "none" });
      return;
    }

    const nextConfig = cloneConfig(config);
    nextConfig.demand.intervalHours = demandInterval;
    nextConfig.demand.threshold = demandThreshold;
    nextConfig.demand.durationSeconds = demandDuration;
    nextConfig.schedule.intervalDays = scheduleIntervalDays;
    nextConfig.schedule.times = scheduleTimes;
    nextConfig.schedule.durationSeconds = scheduleDuration;
    nextConfig.manual.durationSeconds = manualDuration;

    wx.showLoading({ title: "下发中..." });
    callApi("watering.saveConfig", {
      phone: this.data.phone,
      deviceNo: device.deviceNo,
      config: nextConfig,
    }).then((resp) => {
      if (!resp || !resp.success || !resp.data) {
        wx.showToast({ title: getResponseMessage(resp, "保存失败"), icon: "none" });
        return;
      }

      const savedConfig = normalizeWateringConfig(resp.data.config || nextConfig);
      const nextDevice = Object.assign({}, this.data.device, {
        config: savedConfig,
        status: resp.data.status || this.data.device.status,
        online: resp.data.online !== false,
        lastSyncedAt: resp.data.syncedAt || Date.now(),
        updatedAt: Date.now(),
        syncState: "synced",
      });
      this.setData({
        device: nextDevice,
        modeText: MODE_LABELS[nextDevice.config.mode],
        canEdit: isDeviceOnline(nextDevice),
        syncText: getSyncText(nextDevice),
      });
      this.persistDevice(false);
      wx.showToast({ title: "已同步" });
    }).catch(() => {
      wx.showToast({ title: "保存失败", icon: "none" });
    }).finally(() => {
      wx.hideLoading();
    });
  },

  persistDevice(showToast) {
    const devices = getStoredDevices(this.data.phone);
    const updatedDevices = devices.map((item) => (
      item.id === this.data.device.id ? this.data.device : item
    ));
    setStoredDevices(this.data.phone, updatedDevices);
    if (showToast) {
      wx.showToast({ title: "已保存" });
    }
  },

  startManualWatering() {
    if (!this.ensureEditable()) {
      return;
    }

    const duration = normalizeInteger(this.data.device.config.manual.durationSeconds, 1, 3600);
    if (!duration) {
      wx.showToast({ title: "请输入浇水秒数", icon: "none" });
      return;
    }

    wx.showLoading({ title: "下发中..." });
    callApi("watering.startManual", {
      phone: this.data.phone,
      deviceNo: this.data.device.deviceNo,
      durationSeconds: duration,
    }).then((resp) => {
      if (!resp || !resp.success || !resp.data) {
        wx.showToast({ title: getResponseMessage(resp, "下发失败"), icon: "none" });
        return;
      }

      this.clearManualTimer();
      const nextDevice = Object.assign({}, this.data.device, {
        status: resp.data.status || "浇水中",
        online: resp.data.online !== false,
        lastWateringAt: resp.data.lastWateringAt || formatTime(new Date()),
        lastSyncedAt: resp.data.syncedAt || Date.now(),
        updatedAt: Date.now(),
        syncState: "synced",
      });
      this.setData({
        device: nextDevice,
        manualRunning: true,
        manualLeft: duration,
        canEdit: isDeviceOnline(nextDevice),
        syncText: getSyncText(nextDevice),
      });
      this.persistDevice(false);
      this.manualTimer = setInterval(() => {
        const nextLeft = this.data.manualLeft - 1;
        if (nextLeft <= 0) {
          this.finishManualWatering();
          return;
        }
        this.setData({ manualLeft: nextLeft });
      }, 1000);
    }).catch(() => {
      wx.showToast({ title: "下发失败", icon: "none" });
    }).finally(() => {
      wx.hideLoading();
    });
  },

  stopManualWatering() {
    callApi("watering.stopManual", {
      phone: this.data.phone,
      deviceNo: this.data.device.deviceNo,
    }).then((resp) => {
      if (!resp || !resp.success || !resp.data) {
        wx.showToast({ title: getResponseMessage(resp, "停止失败"), icon: "none" });
        return;
      }

      this.clearManualTimer();
      const nextDevice = Object.assign({}, this.data.device, {
        status: resp.data.status || "在线",
        online: resp.data.online !== false,
        lastSyncedAt: resp.data.syncedAt || Date.now(),
        updatedAt: Date.now(),
        syncState: "synced",
      });
      this.setData({
        device: nextDevice,
        manualRunning: false,
        manualLeft: 0,
        canEdit: isDeviceOnline(nextDevice),
        syncText: getSyncText(nextDevice),
      });
      this.persistDevice(false);
      wx.showToast({ title: "已停止" });
    }).catch(() => {
      wx.showToast({ title: "停止失败", icon: "none" });
    });
  },

  finishManualWatering() {
    this.clearManualTimer();
    callApi("watering.stopManual", {
      phone: this.data.phone,
      deviceNo: this.data.device.deviceNo,
    }).then((resp) => {
      const nextDevice = Object.assign({}, this.data.device, {
        status: resp && resp.success && resp.data ? (resp.data.status || "在线") : "在线",
        online: !(resp && resp.success && resp.data && resp.data.online === false),
        lastSyncedAt: resp && resp.success && resp.data ? (resp.data.syncedAt || Date.now()) : this.data.device.lastSyncedAt,
        updatedAt: Date.now(),
        syncState: resp && resp.success && resp.data ? "synced" : this.data.device.syncState,
      });
      this.setData({
        device: nextDevice,
        manualRunning: false,
        manualLeft: 0,
        canEdit: isDeviceOnline(nextDevice),
        syncText: getSyncText(nextDevice),
      });
      this.persistDevice(false);
      wx.showToast({ title: "浇水完成" });
    }).catch(() => {
      this.setData({
        manualRunning: false,
        manualLeft: 0,
      });
    });
  },

  clearManualTimer() {
    if (this.manualTimer) {
      clearInterval(this.manualTimer);
      this.manualTimer = null;
    }
  },
});