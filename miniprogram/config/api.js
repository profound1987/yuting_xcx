const API_CONFIG = {
  // mock: 本地原型数据; http: HTTPS/开发服务器; cloud: 微信云函数
  mode: "http",
  baseUrl: "https://api.yutingsmarthome.xin",
  // 微信开发者工具如果遇到本机 HTTPS/TLS reset，可开启 SSH 隧道后走本地转发。
  // 手机预览/开发版如果遇到 HTTPS/TLS reset，可临时走公网 HTTP 8000。
  // 体验版和正式版仍使用 baseUrl。
  useDebugHttp: true,
  debugHttpBaseUrl: "http://39.97.237.214:8000",
  debugHttpDevtoolsOnly: true,
  useDevtoolsTunnel: true,
  devtoolsBaseUrl: "http://127.0.0.1:18000",
  // 真机预览/开发版默认不走裸 IP，避免触发微信 request 合法域名拦截。
  // 只有在真机调试已明确关闭域名校验时，才临时改为 true。
  useDevelopHttpFallback: false,
  developBaseUrl: "http://39.97.237.214:8000",
  cloudFunctionName: "api",
  timeout: 10000,
};

module.exports = API_CONFIG;