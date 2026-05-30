const SESSION_KEY = "yuntingSession";
const DEVICES_KEY_PREFIX = "yuntingDevices";

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

function normalizeNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  if (number < min || number > max) {
    return null;
  }
  return Math.floor(number);
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
    this.setData({
      device,
      modeText: MODE_LABELS[device.config.mode] || "设备管理",
    });
  },

  selectMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({
      "device.config.mode": mode,
      modeText: MODE_LABELS[mode],
    });
    this.persistDevice(false);
  },

  onNumberInput(e) {
    const { section, field } = e.currentTarget.dataset;
    const key = `device.config.${section}.${field}`;
    this.setData({ [key]: e.detail.value });
  },

  saveConfig() {
    const device = this.data.device;
    const config = device.config;
    const demandInterval = normalizeNumber(config.demand.intervalHours, 1, 72);
    const demandThreshold = normalizeNumber(config.demand.threshold, 1, 100);
    const demandDuration = normalizeNumber(config.demand.durationSeconds, 1, 3600);
    const scheduleTimes = normalizeNumber(config.schedule.timesPerDay, 1, 24);
    const scheduleDuration = normalizeNumber(config.schedule.durationSeconds, 1, 3600);
    const manualDuration = normalizeNumber(config.manual.durationSeconds, 1, 3600);

    if (!demandInterval || !demandThreshold || !demandDuration || !scheduleTimes || !scheduleDuration || !manualDuration) {
      wx.showToast({ title: "请输入有效数值", icon: "none" });
      return;
    }

    this.setData({
      "device.config.demand.intervalHours": demandInterval,
      "device.config.demand.threshold": demandThreshold,
      "device.config.demand.durationSeconds": demandDuration,
      "device.config.schedule.timesPerDay": scheduleTimes,
      "device.config.schedule.durationSeconds": scheduleDuration,
      "device.config.manual.durationSeconds": manualDuration,
      "device.updatedAt": Date.now(),
    });
    this.persistDevice(true);
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
    const duration = normalizeNumber(this.data.device.config.manual.durationSeconds, 1, 3600);
    if (!duration) {
      wx.showToast({ title: "请输入浇水秒数", icon: "none" });
      return;
    }

    this.clearManualTimer();
    this.setData({
      manualRunning: true,
      manualLeft: duration,
      "device.status": "浇水中",
      "device.lastWateringAt": formatTime(new Date()),
      "device.updatedAt": Date.now(),
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
  },

  stopManualWatering() {
    this.clearManualTimer();
    this.setData({
      manualRunning: false,
      manualLeft: 0,
      "device.status": "在线",
      "device.updatedAt": Date.now(),
    });
    this.persistDevice(false);
    wx.showToast({ title: "已停止" });
  },

  finishManualWatering() {
    this.clearManualTimer();
    this.setData({
      manualRunning: false,
      manualLeft: 0,
      "device.status": "在线",
      "device.updatedAt": Date.now(),
    });
    this.persistDevice(false);
    wx.showToast({ title: "浇水完成" });
  },

  clearManualTimer() {
    if (this.manualTimer) {
      clearInterval(this.manualTimer);
      this.manualTimer = null;
    }
  },
});