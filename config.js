window.VIDEO_APP_CONFIG = {
  appName: "视频线路播放器",
  pid: "PH",

  // 仅填写你拥有或获准使用的 API。页面中的输入框也可以临时覆盖此列表。
  apiCandidates: [],

  // 与 APK 中观察到的“测速 → 选择 API → 拉取域名配置”架构相似，
  // 但这里默认只处理普通 JSON，不包含任何第三方私有密钥或鉴权信息。
  speedtestPath: "speedtest",
  domainConfigPath: "sys/dmCfg",
  catalogPath: "./data/videos.json",

  requestTimeoutMs: 4500,
  scoreWeights: {
    server: 0.75,
    latency: 0.25
  },

  // 可选：配置你自己的远程视频目录接口，例如 "videos/short"。
  // 返回值可为数组，或放在 data/list/items/records 中。
  remoteCatalogPath: "",

  storageKeys: {
    candidates: "video-player-api-candidates"
  }
};
