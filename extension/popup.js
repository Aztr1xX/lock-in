const $ = (id) => document.getElementById(id);

async function render() {
  const st = await chrome.runtime.sendMessage({ kind: "status" });
  const box = $("status");
  if (st.locked) {
    box.className = "status on";
    box.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `Locked in${st.session?.subject ? ": " + st.session.subject : ""}`;
    const s = document.createElement("span");
    s.textContent = "Blocking is on until you end your session in Lock In.";
    box.append(b, s);
  } else {
    box.className = "status";
    box.innerHTML = "<b>Not in a session</b><span>Blocking turns on by itself when you press Start.</span>";
  }
  const ul = $("sites");
  ul.innerHTML = "";
  for (const site of st.sites) {
    const li = document.createElement("li");
    li.textContent = site;
    const del = document.createElement("button");
    del.textContent = "×";
    del.title = st.locked ? "You can't unblock sites mid-session" : `Stop blocking ${site}`;
    del.disabled = st.locked;
    del.onclick = async () => {
      await chrome.storage.local.set({ sites: st.sites.filter((x) => x !== site) });
      await chrome.runtime.sendMessage({ kind: "sitesChanged" });
      render();
    };
    li.append(del);
    ul.append(li);
  }
}

$("add").onsubmit = async (e) => {
  e.preventDefault();
  let v = $("newsite").value.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!v || !v.includes(".")) return;
  const { sites } = await chrome.storage.local.get(["sites"]);
  const list = sites ?? DEFAULT_SITES;
  if (!list.includes(v)) await chrome.storage.local.set({ sites: [...list, v] });
  await chrome.runtime.sendMessage({ kind: "sitesChanged" });
  $("newsite").value = "";
  render();
};

render();
