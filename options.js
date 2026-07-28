let categories = [];

const $ = (id) => document.getElementById(id);

init();

async function init() {
  const cfg = await ceGetConfig();
  $("apiKey").value = cfg.apiKey || "";
  $("model").value = cfg.model;
  $("enabled").checked = cfg.enabled;
  $("homeOnly").checked = cfg.homeOnly;
  $("skipNoText").checked = cfg.skipNoText;
  categories = JSON.parse(JSON.stringify(cfg.categories));
  renderCats();

  $("addCat").addEventListener("click", () => {
    categories.push({ id: "", label: "", description: "", action: "hide" });
    renderCats();
  });
  $("save").addEventListener("click", save);
  $("testKey").addEventListener("click", testKey);
}

function renderCats() {
  const root = $("cats");
  root.innerHTML = "";
  categories.forEach((cat, i) => {
    const div = document.createElement("div");
    div.className = "cat";

    const left = document.createElement("div");
    const idInput = mkInput(cat.id, "id (short, no spaces)");
    idInput.addEventListener("input", () => (cat.id = idInput.value.trim()));
    const labelInput = mkInput(cat.label, "Label");
    labelInput.style.marginTop = "6px";
    labelInput.addEventListener("input", () => (cat.label = labelInput.value));
    left.append(idInput, labelInput);

    const desc = document.createElement("textarea");
    desc.value = cat.description;
    desc.placeholder = "Describe this category for the model — this text is the prompt.";
    desc.addEventListener("input", () => (cat.description = desc.value));

    const action = document.createElement("select");
    for (const opt of ["keep", "hide"]) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (cat.action === opt) o.selected = true;
      action.append(o);
    }
    action.addEventListener("change", () => (cat.action = action.value));

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "remove";
    del.addEventListener("click", () => {
      categories.splice(i, 1);
      renderCats();
    });

    div.append(left, desc, action, del);
    root.append(div);
  });
}

function mkInput(value, placeholder) {
  const el = document.createElement("input");
  el.type = "text";
  el.value = value;
  el.placeholder = placeholder;
  return el;
}

async function save() {
  const cleaned = categories
    .map((c) => ({
      id: (c.id || "").trim().toLowerCase().replace(/\s+/g, "_"),
      label: (c.label || c.id || "").trim(),
      description: (c.description || "").trim(),
      action: c.action === "hide" ? "hide" : "keep"
    }))
    .filter((c) => c.id && c.description);

  const st = $("saveStatus");
  if (cleaned.length === 0) {
    st.textContent = "Need at least one category with an id and description.";
    st.className = "bad";
    return;
  }
  if (!cleaned.some((c) => c.action === "keep")) {
    st.textContent = "At least one category must be 'keep' (it's also the fallback).";
    st.className = "bad";
    return;
  }
  const ids = cleaned.map((c) => c.id);
  if (new Set(ids).size !== ids.length) {
    st.textContent = "Category ids must be unique.";
    st.className = "bad";
    return;
  }

  const cfg = await ceGetConfig();
  cfg.apiKey = $("apiKey").value.trim();
  cfg.model = $("model").value.trim() || "claude-haiku-4-5";
  cfg.enabled = $("enabled").checked;
  cfg.homeOnly = $("homeOnly").checked;
  cfg.skipNoText = $("skipNoText").checked;
  cfg.categories = cleaned;
  await ceSaveConfig(cfg);
  categories = cleaned;
  renderCats();
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
