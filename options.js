const $ = (id) => document.getElementById(id);

init();

async function init() {
  const cfg = await ceGetConfig();
  $("apiKey").value = cfg.apiKey || "";
  $("model").value = cfg.model;
  $("ruleModel").value = cfg.ruleModel || "";
  $("enabled").checked = cfg.enabled;
  $("homeOnly").checked = cfg.homeOnly !== false;
  $("hideAds").checked = cfg.hideAds !== false;
  $("devBridge").checked = cfg.devBridge !== false;
  $("clusterPrompt").value = cfg.clusterPrompt || "";
  chrome.runtime.sendMessage({ type: "GET_TUNING" }, (t) => {
    if (t && t.defaultClusterPrompt) $("clusterPrompt").placeholder = t.defaultClusterPrompt;
  });
  refreshRule();

  $("save").addEventListener("click", save);
  $("testKey").addEventListener("click", testKey);
  $("deriveRule").addEventListener("click", () => {
    $("ruleStatus").textContent = "Rewriting…";
    chrome.runtime.sendMessage({ type: "DERIVE_RULE" }, () => setTimeout(refreshRule, 8000));
  });
  $("resetLabels").addEventListener("click", () => {
    if (!confirm("Forget every slop / not-slop tag and go back to the seed rule?")) return;
    chrome.runtime.sendMessage({ type: "RESET_LABELS" }, refreshRule);
  });
}

function refreshRule() {
  chrome.runtime.sendMessage({ type: "GET_RULE" }, (r) => {
    if (!r || r.error) return;
    const n = (r.nSlop || 0) + (r.nOk || 0);
    $("ruleMeta").textContent = r.seed
      ? "Seed rule — no tags yet. Tag posts on x.com/home and this gets rewritten."
      : `Derived from ${n} tags (${r.nSlop} slop, ${r.nOk} not slop) at ${new Date(r.derivedAt).toLocaleString()}${r.updating ? " · updating…" : ""}`;
    $("ruleText").textContent = r.rule;
    $("ruleStatus").textContent = r.error ? "Last rewrite failed: " + r.error : "";
  });
}

async function save() {
  const st = $("saveStatus");
  const cfg = await ceGetConfig();
  cfg.apiKey = $("apiKey").value.trim();
  cfg.model = $("model").value.trim() || "claude-sonnet-5";
  cfg.ruleModel = $("ruleModel").value.trim();
  cfg.enabled = $("enabled").checked;
  cfg.homeOnly = $("homeOnly").checked;
  cfg.hideAds = $("hideAds").checked;
  cfg.devBridge = $("devBridge").checked;
  cfg.clusterPrompt = $("clusterPrompt").value.trim();
  delete cfg.skipNoText;
  delete cfg.noTextAction;
  delete cfg.showLabels;
  delete cfg.categories;
  await ceSaveConfig(cfg);
  st.textContent = "Saved.";
  st.className = "ok";
  setTimeout(() => (st.textContent = ""), 2500);
}

function testKey() {
  const st = $("status");
  st.textContent = "Testing…";
  st.className = "";
  chrome.runtime.sendMessage(
    { type: "TEST_KEY", apiKey: $("apiKey").value.trim(), model: $("model").value.trim() },
    (resp) => {
      if (resp && resp.ok) {
        st.textContent = "Key works ✓";
        st.className = "ok";
      } else {
        st.textContent = "Failed: " + (resp && resp.error ? resp.error : "unknown error");
        st.className = "bad";
      }
    }
  );
}
