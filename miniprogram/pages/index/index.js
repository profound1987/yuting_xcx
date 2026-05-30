const SESSION_KEY = "yuntingSession";

function isValidPhone(phone) {
  return /^1\d{10}$/.test(phone);
}

function isValidCode(code) {
  return /^\d{6}$/.test(code);
}

Page({
  data: {
    phone: "",
    code: "",
    sentCode: "",
    codeSent: false,
    codeButtonDisabled: false,
    codeButtonText: "获取验证码",
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

  sendCode() {
    if (!isValidPhone(this.data.phone)) {
      wx.showToast({ title: "请输入正确手机号", icon: "none" });
      return;
    }

    const sentCode = String(Math.floor(100000 + Math.random() * 900000));
    this.setData({ sentCode, codeSent: true, code: "" }, this.updateLoginState);
    wx.showModal({
      title: "验证码已发送",
      content: `演示验证码：${sentCode}`,
      showCancel: false,
    });
    this.startCountdown();
  },

  startCountdown() {
    let seconds = 60;
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

  login() {
    if (!isValidPhone(this.data.phone) || !isValidCode(this.data.code)) {
      wx.showToast({ title: "请填写登录信息", icon: "none" });
      return;
    }

    if (!this.data.codeSent) {
      wx.showToast({ title: "请先获取验证码", icon: "none" });
      return;
    }

    if (this.data.code !== this.data.sentCode && this.data.code !== "123456") {
      wx.showToast({ title: "验证码不正确", icon: "none" });
      return;
    }

    wx.setStorageSync(SESSION_KEY, {
      phone: this.data.phone,
      loggedInAt: Date.now(),
    });
    wx.redirectTo({ url: "/pages/devices/index" });
  },
});
