import { PROTOCOLS, ALL_SERVICES, shortUuid } from "./protocols.js";

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem("glow:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("glow:" + k, JSON.stringify(v)); } catch {} },
};

// ---------- state ----------
const state = {
  on: true,
  hsv: store.get("hsv", { h: 22, s: 0.85, v: 1 }),
  bri: store.get("bri", 80),
  proto: null,
  device: null,
  char: null,
  demo: false,
};

const SCENES = [
  ["Sunset", [255, 70, 10]], ["Golden hour", [255, 140, 20]], ["Dusk", [190, 40, 90]],
  ["Rose", [255, 40, 80]], ["Lavender", [150, 60, 255]], ["Ocean", [0, 90, 255]],
  ["Forest", [20, 200, 40]], ["Candle", [255, 90, 0]], ["Warm white", [255, 170, 80]],
  ["Daylight", [255, 255, 255]], ["Red", [255, 0, 0]], ["Night light", [120, 20, 0]],
];

// ---------- color helpers ----------
function hsvToRgb({ h, s, v }) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
}
function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx };
}
const hex = (rgb) => "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
const bytesToHex = (a) => [...a].map((b) => b.toString(16).padStart(2, "0")).join(" ");

// ---------- bluetooth write queue (latest value per key wins, so dragging stays smooth) ----------
const pending = new Map();
let writing = false;
function send(key, bytes) {
  if (!bytes) return;
  pending.set(key, bytes);
  pump();
}
async function pump() {
  if (writing) return;
  writing = true;
  try {
    while (pending.size) {
      const [key, value] = pending.entries().next().value;
      pending.delete(key);
      // A value is either one frame or a list of frames that must go out in order.
      for (const bytes of Array.isArray(value[0]) ? value : [value]) {
        log("→ " + bytesToHex(bytes));
        if (state.demo || !state.char) { await new Promise((r) => setTimeout(r, 20)); continue; }
        const data = new Uint8Array(bytes);
        try {
          if (state.char.properties.writeWithoutResponse) await state.char.writeValueWithoutResponse(data);
          else await state.char.writeValueWithResponse(data);
        } catch (e) { log("write failed: " + e.message); }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  } finally { writing = false; }
}

// ---------- high-level lamp actions ----------
function outputRgb() {
  const rgb = hsvToRgb(state.hsv);
  if (state.proto && state.proto.hardwareBrightness !== false) return rgb;
  return rgb.map((x) => Math.round((x * state.bri) / 100));
}
function applyColor() {
  if (!state.proto) return;
  send("color", state.proto.color(...outputRgb()));
}
function applyBrightness() {
  if (!state.proto) return;
  if (state.proto.brightness) send("bri", state.proto.brightness(state.bri));
  else applyColor();
}
function setPower(on) {
  state.on = on;
  if (state.proto) {
    const pre = !on && state.proto.offPrelude ? [state.proto.offPrelude()] : [];
    send("power", [...pre, state.proto.power(on)]);
  }
  if (on) { applyColor(); applyBrightness(); }
  renderPower();
}
function setColor(rgb, { push = true } = {}) {
  state.hsv = rgbToHsv(rgb);
  state.hsv.v = 1;
  if (rgb.every((x) => x === 0)) state.hsv = { h: 0, s: 0, v: 1 };
  store.set("hsv", state.hsv);
  if (push) { if (!state.on) setPower(true); else applyColor(); }
  renderColor();
}
function setBri(pct, { push = true } = {}) {
  state.bri = Math.max(1, Math.min(100, Math.round(pct)));
  store.set("bri", state.bri);
  if (push) applyBrightness();
  renderColor();
}

// ---------- connect ----------
async function connect() {
  if (!navigator.bluetooth) { showUnsupported(); return; }
  try {
    setStatus("Choose your lamp…");
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ALL_SERVICES });
    state.device = device;
    store.set("lastName", device.name || "");
    device.addEventListener("gattserverdisconnected", onDisconnect);
    await attach(device);
  } catch (e) {
    setStatus(e.name === "NotFoundError" ? "No lamp chosen" : "Couldn't connect: " + e.message);
  }
}

async function attach(device) {
  setStatus("Connecting to " + (device.name || "lamp") + "…");
  const server = await device.gatt.connect();
  const services = await server.getPrimaryServices().catch(() => []);
  const uuids = services.map((s) => s.uuid);

  const forced = store.get("proto:" + device.id, null);
  const name = (device.name || "").toLowerCase();
  const candidates = PROTOCOLS.filter((p) => uuids.includes(p.service));
  let proto = PROTOCOLS.find((p) => p.id === forced)
    || candidates.find((p) => p.namePrefixes.some((n) => name.startsWith(n.toLowerCase())));
  // Several lamp families share the same service, so ask the lamp which one it is.
  if (!proto && candidates.length > 1) proto = await probe(server, candidates);
  proto ||= candidates.find((p) => !p.probe) || candidates[0];
  state.proto = null; state.char = null;
  if (proto) {
    try {
      const svc = await server.getPrimaryService(proto.service);
      state.char = await svc.getCharacteristic(proto.write);
      state.proto = proto;
    } catch (e) { log("protocol setup failed: " + e.message); }
  }
  await buildExplorer(services);
  if (state.proto) {
    setStatus("Connected · " + (device.name || "lamp"), true);
    document.body.dataset.connected = "yes";
    renderEffects();
    setPower(true);
  } else {
    setStatus("Connected, but this lamp's language is unknown. Open Advanced below.", true);
    document.body.dataset.connected = "unknown";
    $("#advanced").open = true;
  }
}

async function probe(server, candidates) {
  for (const p of candidates.filter((c) => c.probe)) {
    try {
      const svc = await server.getPrimaryService(p.service);
      const notify = await svc.getCharacteristic(p.notify);
      const write = await svc.getCharacteristic(p.write);
      let matched = false;
      const onValue = (e) => { if (p.probeReply(new Uint8Array(e.target.value.buffer))) matched = true; };
      notify.addEventListener("characteristicvaluechanged", onValue);
      await notify.startNotifications();
      log("probe " + p.id + " → " + bytesToHex(p.probe));
      await write.writeValue(new Uint8Array(p.probe));
      for (let i = 0; i < 15 && !matched; i++) await new Promise((r) => setTimeout(r, 100));
      notify.removeEventListener("characteristicvaluechanged", onValue);
      await notify.stopNotifications().catch(() => {});
      log("probe " + p.id + (matched ? ": match" : ": no reply"));
      if (matched) return p;
    } catch (e) { log("probe " + p.id + " failed: " + e.message); }
  }
  return null;
}

async function onDisconnect() {
  document.body.dataset.connected = "no";
  setStatus("Disconnected — reconnecting…");
  for (let i = 0; i < 4 && state.device; i++) {
    try { await attach(state.device); return; } catch { await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  setStatus("Disconnected. Tap Connect to try again.");
}

function startDemo() {
  state.demo = true;
  state.proto = PROTOCOLS[0];
  document.body.dataset.connected = "yes";
  setStatus("Demo mode · no lamp (commands are only logged)", true);
  renderEffects();
  setPower(true);
}

// ---------- fades & timers ----------
let fade = null;
function startFade({ toRgb, toBri, minutes, thenOff }) {
  cancelFade();
  const from = { rgb: hsvToRgb(state.hsv), bri: state.bri };
  const t0 = Date.now(), dur = minutes * 60000;
  const tick = () => {
    const p = Math.min(1, (Date.now() - t0) / dur);
    const e = p * p * (3 - 2 * p);
    const rgb = from.rgb.map((c, i) => Math.round(c + (toRgb[i] - c) * e));
    state.hsv = rgbToHsv(rgb); state.hsv.v = 1;
    state.bri = Math.max(1, Math.round(from.bri + (toBri - from.bri) * e));
    applyColor(); applyBrightness(); renderColor();
    const left = Math.ceil((dur - (Date.now() - t0)) / 60000);
    $("#fadeStatus").textContent = p < 1 ? `Fading… ${left} min left` : "";
    if (p >= 1) { cancelFade(); if (thenOff) setPower(false); }
  };
  fade = setInterval(tick, 1000);
  tick();
  $("#fadeCancel").hidden = false;
  requestWakeLock();
}
function cancelFade() {
  clearInterval(fade); fade = null;
  $("#fadeStatus").textContent = ""; $("#fadeCancel").hidden = true;
  releaseWakeLock();
}
let wakeLock = null;
async function requestWakeLock() { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
function releaseWakeLock() { wakeLock?.release?.(); wakeLock = null; }

// ---------- UI rendering ----------
function setStatus(text, ok = false) { $("#status").textContent = text; $("#status").dataset.ok = ok ? "yes" : "no"; }
function log(line) {
  const el = $("#log");
  el.textContent = (line + "\n" + el.textContent).slice(0, 4000);
}
function renderPower() {
  $("#power").setAttribute("aria-pressed", String(state.on));
  $("#power").querySelector("span").textContent = state.on ? "On" : "Off";
  document.body.dataset.on = state.on ? "yes" : "no";
}
function renderColor() {
  const rgb = hsvToRgb(state.hsv);
  document.documentElement.style.setProperty("--lamp", hex(rgb));
  document.documentElement.style.setProperty("--glow", (0.15 + state.bri / 160).toFixed(2));
  $("#bri").value = state.bri; $("#briVal").textContent = state.bri + "%";
  $("#hex").textContent = hex(rgb).toUpperCase();
  drawWheel();
}
function renderEffects() {
  const box = $("#effects");
  box.innerHTML = "";
  for (const [name, code] of state.proto?.effects || []) {
    const b = document.createElement("button");
    b.className = "chip"; b.textContent = name;
    b.onclick = () => {
      cancelFade();
      const sp = +$("#speed").value;
      send("color", state.proto.effect(code, sp));
      if (state.proto.speed) send("speed", state.proto.speed(sp));
    };
    box.append(b);
  }
  $("#protoName").textContent = state.proto ? state.proto.name : "none";
}
function renderScenes() {
  const box = $("#scenes");
  for (const [name, rgb] of SCENES) {
    const b = document.createElement("button");
    b.className = "scene"; b.style.setProperty("--c", hex(rgb));
    b.innerHTML = `<i></i><span>${name}</span>`;
    b.onclick = () => { cancelFade(); setColor(rgb); };
    box.append(b);
  }
}
function renderFavs() {
  const favs = store.get("favs", []);
  const box = $("#favs");
  box.innerHTML = "";
  favs.forEach((rgb, i) => {
    const b = document.createElement("button");
    b.className = "fav"; b.style.background = hex(rgb); b.title = "Tap to use · long-press to remove";
    b.setAttribute("aria-label", "Saved color " + hex(rgb));
    let t;
    b.onpointerdown = () => { t = setTimeout(() => { favs.splice(i, 1); store.set("favs", favs); renderFavs(); t = null; }, 600); };
    b.onpointerup = () => { if (t) { clearTimeout(t); cancelFade(); setColor(rgb); } };
    b.onpointerleave = () => clearTimeout(t);
    box.append(b);
  });
  const add = document.createElement("button");
  add.className = "fav add"; add.textContent = "+"; add.setAttribute("aria-label", "Save current color");
  add.onclick = () => { favs.push(hsvToRgb(state.hsv)); store.set("favs", favs.slice(-12)); renderFavs(); };
  box.append(add);
}

// ---------- color wheel ----------
const wheel = $("#wheel");
const ctx = wheel.getContext("2d");
let wheelImg = null;
function buildWheel() {
  const dpr = window.devicePixelRatio || 1;
  const size = wheel.clientWidth * dpr;
  wheel.width = wheel.height = size;
  const img = ctx.createImageData(size, size);
  const r = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - r, dy = y - r, d = Math.hypot(dx, dy) / r;
    if (d > 1) continue;
    const h = (Math.atan2(dy, dx) * 180) / Math.PI + 180;
    const [R, G, B] = hsvToRgb({ h, s: d, v: 1 });
    const i = (y * size + x) * 4;
    img.data.set([R, G, B, d > 0.985 ? Math.round(255 * (1 - d) / 0.015) : 255], i);
  }
  wheelImg = img;
  drawWheel();
}
function drawWheel() {
  if (!wheelImg) return;
  ctx.putImageData(wheelImg, 0, 0);
  const r = wheel.width / 2;
  const a = ((state.hsv.h - 180) * Math.PI) / 180;
  const x = r + Math.cos(a) * state.hsv.s * r, y = r + Math.sin(a) * state.hsv.s * r;
  const dpr = window.devicePixelRatio || 1;
  ctx.lineWidth = 3 * dpr; ctx.strokeStyle = "#fff";
  ctx.beginPath(); ctx.arc(x, y, 12 * dpr, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1 * dpr; ctx.strokeStyle = "rgba(0,0,0,.4)";
  ctx.beginPath(); ctx.arc(x, y, 14 * dpr, 0, Math.PI * 2); ctx.stroke();
}
function pickFromWheel(ev) {
  const rect = wheel.getBoundingClientRect();
  const dx = ev.clientX - rect.left - rect.width / 2, dy = ev.clientY - rect.top - rect.height / 2;
  const s = Math.min(1, Math.hypot(dx, dy) / (rect.width / 2));
  const h = (Math.atan2(dy, dx) * 180) / Math.PI + 180;
  cancelFade();
  state.hsv = { h, s, v: 1 };
  store.set("hsv", state.hsv);
  if (!state.on) setPower(true); else applyColor();
  renderColor();
}
wheel.addEventListener("pointerdown", (e) => { wheel.setPointerCapture(e.pointerId); pickFromWheel(e); });
wheel.addEventListener("pointermove", (e) => { if (wheel.hasPointerCapture(e.pointerId)) pickFromWheel(e); });

// ---------- advanced / explorer ----------
async function buildExplorer(services) {
  const box = $("#chars");
  box.innerHTML = "";
  const sel = $("#protoSelect");
  sel.innerHTML = `<option value="">Auto-detect</option>` +
    PROTOCOLS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  sel.value = store.get("proto:" + state.device?.id, "") || "";
  for (const svc of services) {
    const chars = await svc.getCharacteristics().catch(() => []);
    for (const c of chars) {
      const props = Object.entries({ r: c.properties.read, w: c.properties.write, wn: c.properties.writeWithoutResponse, n: c.properties.notify })
        .filter(([, v]) => v).map(([k]) => k).join(",");
      if (!c.properties.write && !c.properties.writeWithoutResponse) continue;
      const opt = document.createElement("option");
      opt.value = svc.uuid + "|" + c.uuid;
      opt.textContent = `${shortUuid(svc.uuid)} › ${shortUuid(c.uuid)} (${props})`;
      opt._char = c;
      box.append(opt);
    }
  }
  if (!box.options.length) box.innerHTML = `<option>No writable characteristics found</option>`;
}
$("#rawSend").onclick = async () => {
  const opt = $("#chars").selectedOptions[0];
  const bytes = ($("#raw").value.match(/[0-9a-f]{2}/gi) || []).map((h) => parseInt(h, 16));
  if (!opt?._char || !bytes.length) { log("pick a characteristic and enter hex bytes"); return; }
  log("raw → " + bytesToHex(bytes));
  try { await opt._char.writeValue(new Uint8Array(bytes)); } catch (e) { log("raw write failed: " + e.message); }
};
$("#protoSelect").onchange = async (e) => {
  if (!state.device) return;
  store.set("proto:" + state.device.id, e.target.value || null);
  await attach(state.device).catch((err) => log(err.message));
};

function showUnsupported() {
  $("#unsupported").hidden = false;
  setStatus("This browser can't use Bluetooth");
}

// ---------- wire up ----------
$("#connect").onclick = connect;
$("#demo").onclick = startDemo;
$("#power").onclick = () => { cancelFade(); setPower(!state.on); };
$("#bri").oninput = (e) => { cancelFade(); setBri(+e.target.value); };
$("#fadeCancel").onclick = cancelFade;
$("#sunset").onclick = () => startFade({ toRgb: [255, 30, 0], toBri: 1, minutes: +$("#fadeMin").value, thenOff: true });
$("#sunrise").onclick = () => {
  state.hsv = rgbToHsv([255, 20, 0]); state.bri = 1;
  if (!state.on) setPower(true);
  startFade({ toRgb: [255, 200, 120], toBri: 100, minutes: +$("#fadeMin").value, thenOff: false });
};
$("#sleep").onclick = () => startFade({ toRgb: hsvToRgb(state.hsv), toBri: state.bri, minutes: +$("#fadeMin").value, thenOff: true });
$("#fadeMin").oninput = (e) => ($("#fadeMinVal").textContent = e.target.value + " min");

if (!navigator.bluetooth) showUnsupported();
renderScenes(); renderFavs(); renderPower();
new ResizeObserver(buildWheel).observe(wheel);
renderColor();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
