const SESSION_KEY = "yuntingSession";
const { callApi } = require("../../services/apiClient");

function isValidPhone(phone) {
  return /^1\d{10}$/.test(phone);
}

function isValidCode(code) {
  return /^\d{6}$/.test(code);
}

function getRequestErrorMessage(error) {
  const message = error && (error.errMsg || error.message);
  if (!message) {
    return "网络请求失败，请检查网络和接口配置";
  }
  return `网络请求失败：${message}`;
}

Page({
  data: {
    phone: "",
    code: "",
    codeSent: false,
    codeButtonDisabled: false,
    codeButtonText: "获取验证码",
    sendingCode: false,
    loggingIn: false,
    canLogin: false,
  },

  onLoad() {
    const session = wx.getStorageSync(SESSION_KEY);
    if (session && session.phone) {
      wx.redirectTo({ url: "/pages/devices/index" });
    }
  },

  onUnload() {
    this.clearCountdown();
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value.trim() }, this.updateLoginState);
  },

  onCodeInput(e) {
    this.setData({ code: e.detail.value.trim() }, this.updateLoginState);
  },

  updateLoginState() {
    this.setData({
      canLogin: isValidPhone(this.data.phone) && isValidCode(this.data.code),
    });
  },

  async sendCode() {
    if (!isValidPhone(this.data.phone)) {
      wx.showToast({ title: "请输入正确手机号", icon: "none" });
      return;
    }

    if (this.data.sendingCode || this.data.codeButtonDisabled) {
      return;
    }

    this.setData({
      sendingCode: true,
      codeButtonDisabled: true,
      codeButtonText: "发送中...",
    });
    wx.showLoading({ title: "发送中..." });

    let resp = null;
    let requestError = null;
    try {
      resp = await callApi("auth.sendCode", { phone: this.data.phone, scene: "login" });
    } catch (error) {
      requestError = error;
      resp = null;
    }
    wx.hideLoading();
    this.setData({ sendingCode: false });

    if (!resp || !resp.success) {
      const cooldownSeconds = resp && resp.data && resp.data.cooldownSeconds;
      if (cooldownSeconds) {
        this.startCountdown(cooldownSeconds);
      } else {
        this.clearCountdown();
      }
      if (requestError) {
        wx.showModal({
          title: "验证码发送失败",
          content: getRequestErrorMessage(requestError),
          showCancel: false,
        });
        return;
      }
      wx.showToast({ title: (resp && resp.message) || "验证码发送失败", icon: "none" });
      return;
    }

    this.setData({ codeSent: true, code: "" }, this.updateLoginState);
    this.startCountdown((resp.data && resp.data.cooldownSeconds) || 60);
    if (resp.data && resp.data.devCode) {
      wx.showModal({
        title: "验证码已发送",
        content: `开发验证码：${resp.data.devCode}`,
        showCancel: false,
      });
      return;
    }
    wx.showToast({ title: "验证码已发送" });
  },

  startCountdown(totalSeconds) {
    let seconds = Math.max(1, Number(totalSeconds) || 60);
    this.clearCountdown();
    this.setData({ codeButtonDisabled: true, codeButtonText: `${seconds}s` });
    this.countdownTimer = setInterval(() => {
      seconds -= 1;
      if (seconds <= 0) {
        this.clearCountdown();
        return;
      }
      this.setData({ codeButtonText: `${seconds}s` });
    }, 1000);
  },

  clearCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.setData({ codeButtonDisabled: false, codeButtonText: "获取验证码" });
  },

  async login() {
    if (!isValidPhone(this.data.phone) || !isValidCode(this.data.code)) {
      wx.showToast({ title: "请填写登录信息", icon: "none" });
      return;
    }

    if (!this.data.codeSent) {
      wx.showToast({ title: "请先获取验证码", icon: "none" });
      return;
    }

    if (this.data.loggingIn) {
      return;
    }

    this.setData({ loggingIn: true });
    wx.showLoading({ title: "登录中..." });

    let resp = null;
    let requestError = null;
    try {
      resp = await callApi("auth.loginByCode", {
        phone: this.data.phone,
        code: this.data.code,
      });
    } catch (error) {
      requestError = error;
      resp = null;
    }
    wx.hideLoading();
    this.setData({ loggingIn: false });

    if (!resp || !resp.success || !resp.data || !resp.data.authSession) {
      if (requestError) {
        wx.showModal({
          title: "登录失败",
          content: getRequestErrorMessage(requestError),
          showCancel: false,
        });
        return;
      }
      wx.showToast({ title: (resp && resp.message) || "登录失败", icon: "none" });
      return;
    }

    wx.setStorageSync(SESSION_KEY, {
      phone: this.data.phone,
      phoneMasked: resp.data.authSession.phoneMasked,
      user: resp.data.user,
      authSession: resp.data.authSession,
      sessionToken: resp.data.authSession.sessionToken,
      loggedInAt: Date.now(),
    });
    wx.redirectTo({ url: "/pages/devices/index" });
  },
});
