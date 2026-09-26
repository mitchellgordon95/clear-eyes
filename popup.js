const $ = (id) => document.getElementById(id);

refresh();

$("enabled").addEventListener("change", async () => {
  chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (resp) => {
    if (!resp || !resp.config) return;
    const cfg = resp.config;
    cfg.enabled = $("enabled").checked;
    chrome.storage.local.set({ config: cfg });
  });
});

$("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
$("openOptions2").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
$("resetStats").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: "RESET_STATS" }, refresh);
});
$("resetClusters").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: "RESET_CLUSTERS" }, refresh);
});

function refresh() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
    if (!resp || resp.error) return;
    $("enabled").checked = !!resp.config.enabled;
    $("classified").textContent = resp.stats.classified;
    $("clusters").textContent = resp.clusterCount;
    $("apiCalls").textContent = resp.stats.apiCalls;
    $("noKey").style.display = resp.config.apiKey ? "none" : "block";
    $("healthWarn").style.display = resp.selectorHealth && resp.selectorHealth.ok === false ? "block" : "none";
    if (resp.lastError && resp.lastError.message) {
      const mins = Math.round((Date.now() - resp.lastError.at) / 60000);
      $("lastError").textContent = `Last API error (${mins}m ago): ${resp.lastError.message}`;
      $("lastError").style.display = "block";
    } else {
      $("lastError").style.display = "none";
    }
  });
}
