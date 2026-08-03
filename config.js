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
  signinPath: "users/signin",
  userInfoPath: "users/info",
  shortCategoryPath: "videos/shortCate",
  videoCatalogPath: "videos/short",
  authorInfoPath: "users/{uid}/info",
  authorVideosPath: "users/{uid}/videos",
  videoDetailPath: "videos/{id}",
  defaultVideoParams: {
    page: 1,
    pageSize: 10,
    categorieId: ""
  },

  // sys/dmCfg 下发新的 API 域名后再次测速，并将后续登录和视频请求切到可用的新线路。
  useDynamicApiDomains: true,
  defaultChannel: "",
  defaultInviteCode: "",

  // APK 中使用的 AES-256-ECB-PKCS7 业务数据密钥。
  aesKey: "sFRUdDdCbu62vfSnrJaPedBRCyKyLu8m",

  // APK 的 .ceb/.geb 图片解密密钥。
  imageAesKey: "82758dd12749c777ef579f1839ceea6a",

  // APK assets/www/encrypt.key 的 16 字节内容，用于 HLS AES-128 分片解密。
  mediaKeyBase64: "HscELgq8dVNfyKujQOGoaA==",

  requestTimeoutMs: 10000,
  resourceProbeTimeoutMs: 4500,
  categoryFallbackLimit: 8,
  debugRequestLimit: 20,
  authorPageSize: 12,
  autoStart: true,

  storageKeys: {
    token: "hq-video-token",
    uuid: "hq-video-device-uuid",
    categoryId: "hq-video-category-id",
    apiCandidates: "hq-video-api-candidates",
    captchaCode: "hq-video-captcha-code",
    captchaKey: "hq-video-captcha-key"
  }
};

// 页面解析阶段同步加载标签接口、标签作者辅助功能和已下载视频封面补齐器。
document.write('<script src="./tag-source-switch.js?v=20260802-28"><\/script>');
document.write('<script src="./tag-response-adapter.js?v=20260802-30"><\/script>');
document.write('<script src="./tag-author-tools.js?v=20260802-32"><\/script>');
document.write('<script src="./tag-author-archive-fix.js?v=20260803-33"><\/script>');
document.write('<script src="./archive-cover-backfill.js?v=20260803-34"><\/script>');
