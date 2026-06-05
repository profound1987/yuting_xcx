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

function isDevtoolsRuntime() {
  try {
    return wx.getSystemInfoSync().platform === "devtools";
  } catch (error) {
    return false;
  }
}

function getMiniProgramEnvVersion() {
  try {
    const accountInfo = wx.getAccountInfoSync && wx.getAccountInfoSync();
    return accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion;
  } catch (error) {
    return "";
  }
  return "";
}

function getHttpBaseUrl() {
  const isDevtools = isDevtoolsRuntime();

  if (apiConfig.useDebugHttp && apiConfig.debugHttpBaseUrl) {
    if (!apiConfig.debugHttpDevtoolsOnly || isDevtools) {
      return apiConfig.debugHttpBaseUrl;
    }
  }
  if (apiConfig.useDevtoolsTunnel && isDevtools && apiConfig.devtoolsBaseUrl) {
    return apiConfig.devtoolsBaseUrl;
  }
  if (apiConfig.useDevelopHttpFallback && !isDevtools && apiConfig.developBaseUrl) {
    return apiConfig.developBaseUrl;
  }
  if (apiConfig.useDevelopHttpFallback && getMiniProgramEnvVersion() === "develop" && apiConfig.developBaseUrl) {
    return apiConfig.developBaseUrl;
  }
  return apiConfig.baseUrl;
}

function getLastHttpRequestUrl() {
  return wx.getStorageSync("yuntingLastHttpRequestUrl") || "";
}

function httpCall(type, data) {
  const baseUrl = (getHttpBaseUrl() || "").replace(/\/$/, "");
  if (!baseUrl) {
    return Promise.reject(new Error("API baseUrl is required"));
  }
  const url = `${baseUrl}/api`;
  wx.setStorageSync("yuntingLastHttpRequestUrl", url);

  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: "POST",
      timeout: apiConfig.timeout,
      data: { type, data },
      header: {
        "content-type": "application/json",
      },
      success: (resp) => resolve(resp.data),
      fail: (error) => {
        console.error("[apiClient] wx.request failed", { type, url, error });
        reject(error);
      },
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
  getHttpBaseUrl,
  getLastHttpRequestUrl,
};