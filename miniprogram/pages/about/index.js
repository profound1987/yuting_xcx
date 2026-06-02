const SESSION_KEY = "yuntingSession";
const { apiConfig, callApi } = require("../../services/apiClient");

function maskPhone(phone) {
  return String(phone || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function normalizeVersion(value) {
  return value || "开发版未设置";
}

function firstActiveBinding(bindings) {
  return (bindings || []).find((item) => item.status === "active") || (bindings || [])[0] || null;
}

Page({
  data: {
    phone: "",
    phoneMasked: "",
    userId: "",
    userStatus: "未同步",
    appId: "",
    appVersion: "开发版未设置",
    envVersion: "unknown",
    apiMode: apiConfig.mode,
    sdkVersion: "",
    systemText: "",
    openid: "",
    unionid: "",
    openidBoundAt: "",
    wechatStatus: "正在读取账号信息...",
  },

  onLoad() {
    this.loadLocalInfo();
    this.loadProfile();
  },

  loadLocalInfo() {
    const session = wx.getStorageSync(SESSION_KEY) || {};
    const accountInfo = wx.getAccountInfoSync ? wx.getAccountInfoSync() : {};
    const miniProgram = accountInfo.miniProgram || {};
    const systemInfo = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
    this.setData({
      phone: session.phone || "",
      phoneMasked: session.phone ? maskPhone(session.phone) : "",
      userId: session.userId || "",
      appId: miniProgram.appId || "",
      appVersion: normalizeVersion(miniProgram.version),
      envVersion: miniProgram.envVersion || "unknown",
      sdkVersion: systemInfo.SDKVersion || "",
      systemText: [systemInfo.platform, systemInfo.system].filter(Boolean).join(" · "),
    });
  },

  async loadProfile() {
    const session = wx.getStorageSync(SESSION_KEY) || {};
    if (!session.phone && !session.sessionToken) {
      this.setData({ userStatus: "未登录", wechatStatus: "未登录，无法查询微信身份" });
      return;
    }

    let resp = null;
    try {
      resp = await callApi("user.getProfile", {
        phone: session.phone,
        sessionToken: session.sessionToken,
      });
    } catch (error) {
      resp = null;
    }

    if (!resp || !resp.success) {
      this.setData({ userStatus: "未同步", wechatStatus: (resp && resp.message) || "暂时无法连接服务器" });
      return;
    }

    const user = resp.data.user || {};
    const binding = firstActiveBinding(resp.data.wechatBindings);
    const nextSession = Object.assign({}, session, { userId: user.id || session.userId });
    wx.setStorageSync(SESSION_KEY, nextSession);
    this.setData({
      userId: user.id || "",
      userStatus: user.status || "active",
      openid: binding ? binding.openid : "",
      unionid: binding ? binding.unionid : "",
      openidBoundAt: binding ? binding.createdAtText : "",
      wechatStatus: binding ? "已绑定服务端校验过的微信 OpenID" : "未绑定微信 OpenID，可点击获取微信身份",
    });
  },

  bindWechat() {
    if (!wx.login) {
      wx.showToast({ title: "当前环境不支持微信登录", icon: "none" });
      return;
    }

    wx.showLoading({ title: "获取中..." });
    wx.login({
      success: async (loginResp) => {
        if (!loginResp.code) {
          wx.hideLoading();
          wx.showToast({ title: "微信登录失败", icon: "none" });
          return;
        }
        const session = wx.getStorageSync(SESSION_KEY) || {};
        let resp = null;
        try {
          resp = await callApi("auth.bindWechat", {
            phone: session.phone,
            sessionToken: session.sessionToken,
            loginCode: loginResp.code,
          });
        } catch (error) {
          resp = null;
        }
        wx.hideLoading();
        if (!resp || !resp.success) {
          const message = (resp && resp.message) || "微信身份绑定失败";
          this.setData({ wechatStatus: message });
          wx.showToast({ title: message, icon: "none" });
          return;
        }
        const binding = resp.data.wechatBinding || {};
        this.setData({
          openid: binding.openid || "",
          unionid: binding.unionid || "",
          openidBoundAt: binding.createdAtText || "",
          wechatStatus: "已绑定服务端校验过的微信 OpenID",
        });
        wx.showToast({ title: "已获取" });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: "微信登录失败", icon: "none" });
      },
    });
  },

  copyText(e) {
    const value = String(e.currentTarget.dataset.value || "");
    if (!value) {
      return;
    }
    wx.setClipboardData({ data: value });
  },
});