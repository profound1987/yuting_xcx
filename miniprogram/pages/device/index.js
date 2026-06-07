const SESSION_KEY = "yuntingSession";
const DEVICES_KEY_PREFIX = "yuntingDevices";
const MANUAL_DURATION_KEY_PREFIX = "yuntingManualDuration";
const { callApi } = require("../../services/apiClient");

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

function formatTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
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

function isDeviceOnline(device) {
  return !!(device && device.online !== false && device.status !== "离线");
}

function getSyncText(device) {
  if (!isDeviceOnline(device)) {
    return "离线只读";
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
    canSaveConfig: selectedIsAuto && isDeviceOnline(device),
  };
}

function buildDeviceState(device, preferredFeature, currentState) {
  const nextDevice = prepareDeviceForUi(device);
  const baseState = {
    device: nextDevice,
    canEdit: isDeviceOnline(nextDevice),
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
  },

  loadDevice(id) {
    const devices = getStoredDevices(this.data.phone);
    const device = devices.find((item) => item.id === id);
    if (!device) {
      wx.showToast({ title: "设备不存在", icon: "none" });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData(buildDeviceState(device, "", this.data));
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
        config: statusData.config || {},
        configState: statusData.configState || this.data.device.configState || "unconfigured",
        desiredConfig: statusData.desiredConfig || null,
        appliedConfig: statusData.appliedConfig || null,
        desiredConfigVersion: statusData.desiredConfigVersion || 0,
        appliedConfigVersion: statusData.appliedConfigVersion || 0,
        pendingCommandId: statusData.pendingCommandId || "",
        capabilityState: statusData.capabilityState || this.data.device.capabilityState,
        capabilities: statusData.capabilities || this.data.device.capabilities || {},
        telemetry: statusData.telemetry || this.data.device.telemetry || {},
        runtimeState: statusData.runtimeState || this.data.device.runtimeState || {},
        lastWateringAt: statusData.lastWateringAt || this.data.device.lastWateringAt,
        lastSyncedAt: statusData.lastSyncedAt || this.data.device.lastSyncedAt,
        updatedAt: statusData.updatedAt || this.data.device.updatedAt,
      });

      this.setData(buildDeviceState(nextDevice, this.data.selectedFeature, this.data));
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

  selectFeature(e) {
    if (!this.ensureEditable() || this.data.manualRunning || this.data.commandBusy) {
      return;
    }
    const feature = e.currentTarget.dataset.feature;
    this.setData({
      selectedFeature: feature,
      selectedIsManual: feature === "manualWatering",
      selectedIsAuto: !!AUTO_FEATURES[feature],
      canSaveConfig: !!AUTO_FEATURES[feature] && this.data.canEdit,
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
    const updatedDevices = devices.map((item) => (
      item.id === this.data.device.id ? this.data.device : item
    ));
    setStoredDevices(this.data.phone, updatedDevices);
    if (showToast) {
      wx.showToast({ title: "已保存" });
    }
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
      const commandCountdownText = nextLeft > 0
        ? `浇水倒计时，剩余 ${nextLeft} 秒`
        : "浇水时间已到，等待设备完成确认...";
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