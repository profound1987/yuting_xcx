const API_CONFIG = {
  // mock: 本地原型数据; http: HTTPS/开发服务器; cloud: 微信云函数
  mode: "http",
  baseUrl: "https://api.yutingsmarthome.xin",
  cloudFunctionName: "api",
  timeout: 10000,
};

module.exports = API_CONFIG;