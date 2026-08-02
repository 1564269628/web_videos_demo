(() => {
  "use strict";

  const VERSION = "20260802-28";
  const config = window.VIDEO_APP_CONFIG || {};
  const TAGS = [
    { id: "64623525f6ae893737ab81cc", name: "自拍" },
    { id: "646d898b242aa727d18e616d", name: "抖音" }
  ];

  const query = new URL(location.href).searchParams;
  const activeTagId = String(query.get("tagId") || "").trim();
  const knownTag = TAGS.find((item) => item.id === activeTagId) || null;
  const activeTagName = String(query.get("tagName") || knownTag?.name || "自定义标签").trim();

  function log(message, details) {
    console.log(`[TAG SOURCE ${VERSION}] ${message}`, details || "");
    const output = document.querySelector("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : "";
    output.textContent = `[${time}] [标签切换] ${message}${suffix}\n${output.textContent || ""}`.slice(0, 180000);
  }

  function applySourceBeforeStartup() {
    if (!activeTagId) {
      window.TAG_SOURCE_SWITCH = {
        version: VERSION,
        mode: "short",
        tagId: "",
        tagName: "",
        endpoint: config.videoCatalogPath || "videos/short",
        tags: TAGS
      };
      return;
    }

    config.videoCatalogPath = `tag/${encodeURIComponent(activeTagId)}/videos`;
    config.defaultVideoParams = {
      page: 1,
      pageSize: 10,
      compositeSort: 1,
      timeType: 1,
      sourceType: "sourceType"
    };

    window.TAG_SOURCE_SWITCH = {
      version: VERSION,
      mode: "tag",
      tagId: activeTagId,
      tagName: activeTagName,
      endpoint: config.videoCatalogPath,
      tags: TAGS
    };
  }

  function navigateToTag(tagId, tagName) {
    const url = new URL(location.href);
    if (tagId) {
      url.searchParams.set("tagId", tagId);
      url.searchParams.set("tagName", tagName || "自定义标签");
    } else {
      url.searchParams.delete("tagId");
      url.searchParams.delete("tagName");
    }
    url.searchParams.set("sourceVersion", VERSION);
    location.href = url.href;
  }

  function ensureUi() {
    let select = document.querySelector("#tag-select");
    if (select) return select;
    const toolbar = document.querySelector(".library-panel .toolbar");
    if (!toolbar) return null;

    const label = document.createElement("label");
    label.className = "page-label";
    label.htmlFor = "tag-select";
    label.textContent = "标签来源";

    select = document.createElement("select");
    select.id = "tag-select";
    select.className = "category-select";
    select.setAttribute("aria-label", "标签视频来源");

    const source = document.createElement("span");
    source.id = "tag-source-label";
    source.className = "page-label";

    toolbar.insertBefore(label, toolbar.firstChild);
    toolbar.insertBefore(select, label.nextSibling);
    toolbar.insertBefore(source, select.nextSibling);
    return select;
  }

  function installUi() {
    const select = ensureUi();
    if (!select || select.dataset.tagSwitchReady === "1") return;
    select.dataset.tagSwitchReady = "1";

    select.innerHTML = [
      '<option value="">首页短视频 / videos/short</option>',
      ...TAGS.map((item) => `<option value="${item.id}">${item.name} · ${item.id}</option>`),
      '<option value="__custom__">自定义标签 ID…</option>'
    ].join("");

    if (activeTagId) {
      if (!TAGS.some((item) => item.id === activeTagId)) {
        const option = document.createElement("option");
        option.value = activeTagId;
        option.textContent = `${activeTagName} · ${activeTagId}`;
        select.insertBefore(option, select.lastElementChild);
      }
      select.value = activeTagId;
    } else {
      select.value = "";
    }

    const categorySelect = document.querySelector("#category-select");
    const sourceLabel = document.querySelector("#tag-source-label");
    const endpointLabel = document.querySelector(".data-panel .label");

    if (activeTagId) {
      if (categorySelect) {
        categorySelect.disabled = true;
        categorySelect.title = "当前为标签接口模式，categorieId 不参与请求";
      }
      if (sourceLabel) {
        sourceLabel.textContent = `当前：${activeTagName} · /tag/${activeTagId}/videos`;
        sourceLabel.title = activeTagId;
      }
      if (endpointLabel && endpointLabel.textContent.trim() === "videos/short") {
        endpointLabel.textContent = `tag/${activeTagId}/videos`;
      }
      log("已切换到标签视频接口", {
        tagId: activeTagId,
        tagName: activeTagName,
        endpoint: config.videoCatalogPath,
        params: config.defaultVideoParams
      });
    } else {
      if (categorySelect) categorySelect.disabled = false;
      if (sourceLabel) sourceLabel.textContent = "当前：首页短视频 / videos/short";
      log("当前使用首页短视频接口", {
        endpoint: config.videoCatalogPath || "videos/short"
      });
    }

    select.addEventListener("change", () => {
      const value = select.value;
      if (value === "__custom__") {
        const custom = String(prompt("请输入标签 ID：", "") || "").trim();
        if (!custom) {
          select.value = activeTagId || "";
          return;
        }
        const customName = String(prompt("请输入标签名称（可留空）：", "自定义标签") || "自定义标签").trim();
        navigateToTag(custom, customName || "自定义标签");
        return;
      }
      const item = TAGS.find((entry) => entry.id === value);
      navigateToTag(value, item?.name || "");
    });
  }

  applySourceBeforeStartup();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installUi, { once: true });
  } else {
    installUi();
  }
})();
