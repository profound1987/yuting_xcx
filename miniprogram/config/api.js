const API_CONFIG = {
  // mock: 本地原型数据; http: HTTPS/开发服务器; cloud: 微信云函数
  mode: "http",
  baseUrl: "https://yutingsmarthome.xin",
  // 开发者工具继续使用 HTTPS 根域名 API，便于验证正式链路。
  useDebugHttp: false,
  debugHttpBaseUrl: "http://39.97.237.214:8000",
  debugHttpDevtoolsOnly: true,
  useDevtoolsTunnel: false,
  devtoolsBaseUrl: "http://127.0.0.1:18000",
  // 裸 IP 只能用于“真机调试 + 已关闭域名校验”的场景；普通预览/开发版会报 url not in domain list。
  // 当前默认关闭，手机也走 HTTPS API 域名。
  // 如果后续必须用 IP 调 BLE，再临时改为 true。
  useDevelopHttpFallback: false,
  developBaseUrl: "http://39.97.237.214:8000",
  // 临时开关：仅用于真机 BLE 调试绕过短信验证码。上线前必须改回 false。
  enableDevLoginBypass: true,
  devLoginPhone: "13800138000",
  // 临时开关：调试登录态下，配置前云端检查网络失败时允许继续 BLE 调试。上线前必须改回 false。
  allowDevProvisionWithoutCloudCheck: true,
  cloudFunctionName: "api",
  timeout: 10000,
};

module.exports = API_CONFIG;