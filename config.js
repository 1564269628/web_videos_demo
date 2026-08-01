window.VIDEO_APP_CONFIG = {
  appName: "好妻网 · Web 视频播放器",
  pid: "PH",
  webVersion: "1.2.75",

  // APK 1.2.75 内置的 API 引导线路。
  apiCandidates: [
    "https://d1n2abym1937a5.cloudfront.net/api/v1/",
    "https://fall.faj135.com/api/v1/",
    "https://gk.ifryz.cc/api/v1/",
    "https://134.122.129.9:19888/api/v1/",
    "https://34.92.95.149:19888/api/v1/"
  ],

  speedtestPath: "speedtest",
  domainConfigPath: "sys/dmCfg",
  videoCatalogPath: "videos/short",
  defaultVideoParams: {
    page: 1,
    pageSize: 20,
    categorieId: 0
  },

  // APK 中使用的 AES-256-ECB-PKCS7 业务数据密钥。
  aesKey: "sFRUdDdCbu62vfSnrJaPedBRCyKyLu8m",

  // APK assets/www/encrypt.key 的 16 字节内容，用于 HLS AES-128 分片解密。
  mediaKeyBase64: "HscELgq8dVNfyKujQOGoaA==",

  requestTimeoutMs: 10000,
  resourceProbeTimeoutMs: 4500,
  autoStart: true,

  storageKeys: {
    token: "hq-video-token",
    apiCandidates: "hq-video-api-candidates"
  }
};
