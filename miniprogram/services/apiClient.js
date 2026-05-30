const apiConfig = require("../config/api");
const { mockCall } = require("./mockApi");

function cloudCall(type, data) {
  if (!wx.cloud) {
    return Promise.reject(new Error("wx.cloud is not available"));
  }

  return wx.cloud.callFunction({
    name: apiConfig.cloudFunctionName,
    data: { type, data },
  }).then((resp) => resp.result);
}

function httpCall(type, data) {
  const baseUrl = (apiConfig.baseUrl || "").replace(/\/$/, "");
  if (!baseUrl) {
    return Promise.reject(new Error("API baseUrl is required"));
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${baseUrl}/api`,
      method: "POST",
      timeout: apiConfig.timeout,
      data: { type, data },
      header: {
        "content-type": "application/json",
      },
      success: (resp) => resolve(resp.data),
      fail: reject,
    });
  });
}

function callApi(type, data) {
  if (apiConfig.mode === "mock") {
    return mockCall(type, data);
  }

  if (apiConfig.mode === "cloud") {
    return cloudCall(type, data);
  }

  if (apiConfig.mode === "http") {
    return httpCall(type, data);
  }

  return Promise.reject(new Error(`Unknown API mode: ${apiConfig.mode}`));
}

module.exports = {
  apiConfig,
  callApi,
};