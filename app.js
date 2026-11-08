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
        try { await writeChar(state.char, new Uint8Array(bytes)); }
        catch (e) { log("write failed: " + e.message); }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  } finally { writing = false; }
}

// Prefer an acknowledged write when the lamp supports it (that's what the working
// Home Assistant integrations do), and fall back to whatever this browser offers.
// Bluefy and older browsers may lack the newer write methods.
async function writeChar(c, data) {
  const p = c.properties;
  const mode = store.get("writeMode", "auto");
  const withResp = mode === "with" || (mode === "auto" && (p.write || !p.writeWithoutResponse));
  if (withResp && c.writeValueWithResponse) return c.writeValueWithResponse(data);
  if (!withResp && c.writeValueWithoutResponse) return c.writeValueWithoutResponse(data);
  return c.writeValue(data);
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
    let pre = [];
    if (!on) {
      const wake = scheduledWakeLook();
      // The lamp wakes in whatever color/brightness it had when it went off, so if it's
      // scheduled to turn itself on, leave it set to the chosen wake-up look.
      // (Dimming first keeps the color switch from flashing.)
      if (wake) pre = [state.proto.brightness(1), state.proto.color(...wake.rgb), state.proto.brightness(wake.bri)];
      else if (state.proto.offPrelude) pre = [state.proto.offPrelude()];
    }
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
// Look only for things that advertise like a lamp. Some browsers (Bluefy on iPhone)
// hide unnamed devices from the "show everything" list, but still match these filters.
function lampFilters() {
  const filters = [{ services: [ALL_SERVICES.find((s) => s.startsWith("00003519"))] }];
  for (const p of PROTOCOLS) {
    filters.push({ services: [p.service] });
    for (const n of p.namePrefixes) filters.push({ namePrefix: n });
  }
  return filters;
}

async function connect(showAll = false) {
  if (!navigator.bluetooth) { showUnsupported(); return; }
  try {
    setStatus(showAll ? "Choose your lamp from all devices…" : "Looking for lamps…");
    const options = showAll
      ? { acceptAllDevices: true, optionalServices: ALL_SERVICES }
      : { filters: lampFilters(), optionalServices: ALL_SERVICES };
    const device = await navigator.bluetooth.requestDevice(options);
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
      if (proto.notify) await listenForReplies(svc, proto);
    } catch (e) { log("protocol setup failed: " + e.message); }
  }
  await buildExplorer(services);
  if (state.proto) {
    setStatus(device.name || "Connected", true);
    const p = state.char.properties;
    log(`connected: ${device.name || "?"} as ${state.proto.id}; write=${p.write} noResp=${p.writeWithoutResponse}; services ${uuids.map(shortUuid).join(" ")}`);
    document.body.dataset.connected = "yes";
    renderEffects();
    renderScheduleSupport();
    setPower(true);
    // Like the official app: set the lamp's clock, then ask for its status (which includes its schedule).
    if (state.proto.syncTime) send("sync", [state.proto.syncTime(), state.proto.status()]);
  } else {
    setStatus("Connected, but this lamp's language is unknown. Open Advanced below.", true);
    document.body.dataset.connected = "unknown";
    openSettings();
  }
}

let replyChar = null;
async function listenForReplies(svc, proto) {
  try {
    if (replyChar) replyChar.removeEventListener("characteristicvaluechanged", onReply);
    replyChar = await svc.getCharacteristic(proto.notify);
    replyChar.addEventListener("characteristicvaluechanged", onReply);
    await replyChar.startNotifications();
  } catch (e) { log("can't listen for lamp replies: " + e.message); replyChar = null; }
}
function onReply(e) {
  const v = e.target.value;
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  log("← " + bytesToHex(bytes));
  const sched = state.proto?.parseSchedule?.(bytes);
  if (sched) showLampSchedule(sched);
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
  setStatus("Demo mode", true);
  renderEffects();
  renderScheduleSupport();
  setPower(true);
}

// ---------- fades & timers ----------
// A "job" is one running timer. Only one runs at a time.
//   frames: list of {rgb, bri} spread evenly from startAt to endAt (empty = leave the color alone)
//   thenOff: switch the lamp off at endAt
const SUNSET_STYLES = [
  ["Classic", "Orange → red → ember", [[255, 120, 20, 90], [255, 60, 5, 60], [220, 20, 0, 30], [140, 8, 0, 1]]],
  ["Golden hour", "Gold → amber → glow", [[255, 190, 60, 90], [255, 130, 20, 60], [255, 80, 0, 25], [180, 40, 0, 1]]],
  ["Pink dusk", "Peach → pink → violet", [[255, 140, 90, 90], [255, 60, 110, 60], [170, 40, 200, 25], [60, 10, 120, 1]]],
  ["Tropical", "Coral → magenta → indigo", [[255, 100, 60, 90], [240, 30, 120, 60], [110, 20, 200, 25], [20, 10, 140, 1]]],
  ["Fire", "Bright orange → deep red", [[255, 90, 0, 100], [255, 40, 0, 60], [255, 10, 0, 25], [120, 0, 0, 1]]],
  ["Twilight", "Sunset → blue hour", [[255, 110, 30, 85], [230, 50, 80, 55], [70, 40, 220, 25], [10, 20, 120, 1]]],
].map(([name, desc, frames]) => ({ name, desc, frames: frames.map(([r, g, b, bri]) => ({ rgb: [r, g, b], bri })) }));

const SUNRISE_FRAMES = [[120, 5, 0, 1], [255, 40, 0, 15], [255, 110, 20, 45], [255, 170, 80, 75], [255, 215, 160, 100]]
  .map(([r, g, b, bri]) => ({ rgb: [r, g, b], bri }));

let job = null, jobTimer = null;
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtLeft = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`; };
const lerp = (a, b, t) => a + (b - a) * t;
// Next time today (or tomorrow) that the clock shows "HH:MM".
function nextClock(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now() + 30000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function startJob(j) {
  cancelJob();
  job = j;
  if (j.frames.length) j.frames = [{ rgb: hsvToRgb(state.hsv), bri: state.bri, current: true }, ...j.frames];
  jobTimer = setInterval(tickJob, 1000);
  tickJob();
  requestWakeLock();
}
function tickJob() {
  if (!job) return;
  const now = Date.now();
  if (now < job.startAt) { showJob(`starts at ${fmtTime(job.startAt)}`); return; }
  if (job.frames.length) {
    if (job.frames[0].current && !job.begun) {
      // A scheduled wake-up begins from its own first color, not whatever the lamp shows now.
      if (job.kind === "sunrise") job.frames.shift();
      job.begun = true;
      if (!state.on) setPower(true);
    }
    const p = Math.min(1, (now - job.startAt) / (job.endAt - job.startAt));
    const seg = p * (job.frames.length - 1), i = Math.min(job.frames.length - 2, Math.floor(seg)), t = seg - i;
    const a = job.frames[i], b = job.frames[i + 1] || a;
    const rgb = a.rgb.map((c, k) => Math.round(lerp(c, b.rgb[k], t)));
    const bri = Math.max(1, Math.round(lerp(a.bri, b.bri, t)));
    if (hex(rgb) !== hex(hsvToRgb(state.hsv)) || bri !== state.bri) {
      state.hsv = rgbToHsv(rgb); state.hsv.v = 1; state.bri = bri;
      applyColor(); applyBrightness(); renderColor();
    }
  } else if (job.endAt - now < 60000 && state.on) {
    // Sleep timer: soften the last minute instead of snapping off.
    if (!job.fromBri) job.fromBri = state.bri;
    const b = Math.max(1, Math.round(job.fromBri * ((job.endAt - now) / 60000)));
    if (b !== state.bri) { state.bri = b; applyBrightness(); renderColor(); }
  }
  if (now >= job.endAt) {
    const { thenOff, fromBri } = job;
    cancelJob();
    if (fromBri) state.bri = fromBri; // remember the normal brightness for next time
    if (thenOff) setPower(false);
    return;
  }
  showJob(job.thenOff ? `off at ${fmtTime(job.endAt)} · ${fmtLeft(job.endAt - now)} left` : `full brightness at ${fmtTime(job.endAt)}`);
}
function showJob(detail) {
  $("#jobBanner").hidden = false;
  $("#jobTitle").textContent = job.title;
  $("#jobDetail").textContent = detail;
}
function cancelJob() {
  // Cancelling a sleep timer during its last-minute dim puts the brightness back.
  if (job?.fromBri && job.endAt > Date.now()) { state.bri = job.fromBri; applyBrightness(); renderColor(); }
  clearInterval(jobTimer); jobTimer = null; job = null;
  $("#jobBanner").hidden = true;
  releaseWakeLock();
}
// Picking a color by hand stops a sunset/sunrise, but leaves a sleep timer running.
function cancelFade() { if (job && job.kind !== "sleep") cancelJob(); }

function startSleep(endAt) {
  startJob({ kind: "sleep", title: "🌙 Sleep timer", startAt: Date.now(), endAt, frames: [], thenOff: true });
}

// Little helper: a row of single-choice chips.
function chipGroup(box, options, initial, key) {
  let value = store.get(key, initial);
  box.innerHTML = "";
  for (const [label, v] of options) {
    const b = document.createElement("button");
    b.className = "chip"; b.textContent = label;
    b.setAttribute("aria-pressed", String(v === value));
    b.onclick = () => {
      value = v; store.set(key, v);
      box.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
    };
    box.append(b);
  }
  return () => value;
}

function renderTimers() {
  const sleepBox = $("#sleepIn");
  for (const [label, min] of [["15 min", 15], ["30 min", 30], ["45 min", 45], ["1 hr", 60], ["1½ hr", 90], ["2 hr", 120]]) {
    const b = document.createElement("button");
    b.className = "chip"; b.textContent = label;
    b.onclick = () => startSleep(Date.now() + min * 60000);
    sleepBox.append(b);
  }
  $("#sleepAt").value = store.get("sleepAt", "23:00");
  $("#sleepAtGo").onclick = () => { store.set("sleepAt", $("#sleepAt").value); startSleep(nextClock($("#sleepAt").value)); };

  let style = store.get("sunsetStyle", 0);
  const styles = $("#sunsetStyles");
  SUNSET_STYLES.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "style";
    b.style.setProperty("--g", `linear-gradient(90deg, ${s.frames.map((f) => hex(f.rgb)).join(", ")})`);
    b.innerHTML = `<i></i><b>${s.name}</b><span>${s.desc}</span>`;
    b.setAttribute("aria-pressed", String(i === style));
    b.onclick = () => {
      style = i; store.set("sunsetStyle", i);
      styles.querySelectorAll(".style").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
    };
    styles.append(b);
  });
  const sunsetLen = chipGroup($("#sunsetLen"), [["10 min", 10], ["20 min", 20], ["30 min", 30], ["45 min", 45], ["1 hr", 60]], 30, "sunsetLen");
  $("#sunsetGo").onclick = () => {
    const s = SUNSET_STYLES[style];
    startJob({ kind: "sunset", title: "🌇 " + s.name + " sunset", startAt: Date.now(), endAt: Date.now() + sunsetLen() * 60000,
      frames: s.frames.map((f) => ({ ...f })), thenOff: true });
  };

  const sunriseLen = chipGroup($("#sunriseLen"), [["10 min", 10], ["20 min", 20], ["30 min", 30], ["45 min", 45]], 30, "sunriseLen");
  $("#wakeAt").value = store.get("wakeAt", "07:00");
  $("#sunriseGo").onclick = () => {
    store.set("wakeAt", $("#wakeAt").value);
    const endAt = nextClock($("#wakeAt").value);
    const startAt = Math.max(Date.now(), endAt - sunriseLen() * 60000);
    const c = store.get("wakeColor", "natural");
    // "natural" walks through sunrise colors; a chosen color just fades up from dark in that color.
    const frames = c === "natural" ? SUNRISE_FRAMES.map((f) => ({ ...f }))
      : [{ rgb: c, bri: 1 }, { rgb: c, bri: 35 }, { rgb: c, bri: 100 }];
    startJob({ kind: "sunrise", title: "🌅 Wake-up", startAt, endAt, frames, thenOff: false });
  };
  renderWakeColors();
}

// ---------- built-in lamp schedule ----------
const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ALL_DAYS = [true, true, true, true, true, true, true];
let sched = store.get("sched", {
  on: { enabled: false, h: 7, m: 0, days: [...ALL_DAYS] },
  off: { enabled: true, h: 23, m: 0, days: [...ALL_DAYS] },
});
let awaitingSave = false;
const pad = (n) => String(n).padStart(2, "0");
const clockText = (h, m) => new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function daysText(days) {
  const k = days.map((d) => (d ? 1 : 0)).join("");
  if (k === "1111111") return "every day";
  if (k === "1111100") return "weekdays";
  if (k === "0000011") return "weekends";
  if (k === "0000000") return "no days";
  return days.map((d, i) => (d ? DAY_NAMES[i] : null)).filter(Boolean).join(", ");
}

function renderSchedule() {
  for (const which of ["on", "off"]) {
    const a = sched[which];
    $(`#${which}Enabled`).checked = a.enabled;
    $(`#${which}Enabled`).closest(".alarm").classList.toggle("off", !a.enabled);
    $(`#${which}Time`).value = `${pad(a.h)}:${pad(a.m)}`;
    const box = $(`#${which}Days`);
    box.innerHTML = "";
    a.days.forEach((on, i) => {
      const b = document.createElement("button");
      b.className = "day"; b.textContent = DAY_LETTERS[i];
      b.setAttribute("aria-label", DAY_NAMES[i]);
      b.setAttribute("aria-pressed", String(on));
      b.onclick = () => { a.days[i] = !a.days[i]; b.setAttribute("aria-pressed", String(a.days[i])); };
      box.append(b);
    });
  }
}
function readScheduleInputs() {
  for (const which of ["on", "off"]) {
    const [h, m] = ($(`#${which}Time`).value || "00:00").split(":").map(Number);
    Object.assign(sched[which], { enabled: $(`#${which}Enabled`).checked, h, m });
  }
}
function setScheduleStatus(text, kind = "") {
  const el = $("#scheduleStatus");
  el.textContent = text; el.className = "schedule-status " + kind;
}
function describeSchedule(s) {
  const part = (label, a) => (a.enabled ? `${label} ${clockText(a.h, a.m)}, ${daysText(a.days)}` : `${label}: not set`);
  return `${part("On", s.on)} · ${part("Off", s.off)}`;
}
// Color + brightness the lamp should wake up in, if its built-in "turn on" is set.
function scheduledWakeLook() {
  if (!state.proto?.timer || !state.proto.brightness || !sched.on.enabled) return null;
  return { rgb: sched.onColor || [255, 170, 80], bri: sched.onBri || 80 };
}

// The lamp told us what schedule it has saved.
function showLampSchedule(s) {
  // The lamp doesn't store a color, so keep the one picked in Glow.
  sched = { ...sched, on: s.on, off: s.off };
  store.set("sched", sched);
  renderSchedule();
  if (awaitingSave) { awaitingSave = false; setScheduleStatus("✓ Saved on the lamp. " + describeSchedule(s), "ok"); }
  else setScheduleStatus("On the lamp now: " + describeSchedule(s));
}
function renderScheduleSupport() {
  const ok = !!state.proto?.timer;
  $("#scheduleBox").hidden = !ok;
  $("#scheduleUnsupported").hidden = ok;
}
$("#onBri").value = sched.onBri || 80;
$("#onBriVal").textContent = (sched.onBri || 80) + "%";
$("#onBri").oninput = (e) => { sched.onBri = +e.target.value; $("#onBriVal").textContent = e.target.value + "%"; store.set("sched", sched); };
for (const which of ["on", "off"]) {
  $(`#${which}Enabled`).onchange = (e) => { sched[which].enabled = e.target.checked; e.target.closest(".alarm").classList.toggle("off", !e.target.checked); };
}
$("#scheduleSave").onclick = () => {
  if (!state.proto?.timer) return;
  readScheduleInputs();
  for (const which of ["on", "off"]) {
    if (sched[which].enabled && !sched[which].days.some(Boolean)) {
      setScheduleStatus(`Pick at least one day to turn ${which}.`, "err"); return;
    }
  }
  store.set("sched", sched);
  // Set the clock first so the lamp's idea of "7:00" matches yours.
  send("schedule", [state.proto.syncTime(), state.proto.timer(sched.on, sched.off), state.proto.status()]);
  // Put the lamp in its wake-up look now, so it wakes in it even if it turns itself off tonight.
  const wake = scheduledWakeLook();
  if (wake) {
    if (state.on) { cancelFade(); setColor(wake.rgb); setBri(wake.bri); }
    else {
      // The lamp ignores color while off: wake it at 1%, set the look, switch off again.
      const p = state.proto;
      send("wakeLook", [p.power(true), p.brightness(1), p.color(...wake.rgb), p.brightness(wake.bri), p.power(false)]);
      state.hsv = rgbToHsv(wake.rgb); state.hsv.v = 1; state.bri = wake.bri; renderColor();
    }
  }
  if (state.demo) { setScheduleStatus("Demo mode: " + describeSchedule(sched)); return; }
  awaitingSave = true;
  setScheduleStatus("Saving…");
  setTimeout(() => {
    if (awaitingSave) {
      awaitingSave = false;
      setScheduleStatus("Sent. The lamp didn't confirm, so check it turns on/off as expected. " + describeSchedule(sched));
    }
  }, 3000);
};

const WAKE_PRESETS = [
  ["Warm white", [255, 170, 80]], ["Daylight", [255, 255, 255]], ["Golden", [255, 140, 20]],
  ["Sunset orange", [255, 70, 10]], ["Rose", [255, 40, 80]], ["Lavender", [150, 60, 255]],
  ["Ocean", [0, 90, 255]], ["Forest", [20, 200, 40]],
];
function renderWakeColors() {
  renderSwatches($("#wakeColors"), store.get("wakeColor", "natural"),
    (v) => { store.set("wakeColor", v); renderWakeColors(); }, { natural: true, nameEl: $("#wakeColorName") });
  renderSwatches($("#onColors"), sched.onColor || WAKE_PRESETS[0][1],
    (v) => { sched.onColor = v; store.set("sched", sched); renderWakeColors(); });
}

// A row of color circles: presets, saved colors, and "+" for any color.
function renderSwatches(box, chosen, onPick, { natural = false, nameEl = null } = {}) {
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.every((x, i) => x === b[i]);
  const favs = store.get("favs", []).map((rgb) => ["Saved color", rgb]);
  const options = [...(natural ? [["Natural sunrise (red → warm white)", "natural"]] : []), ...WAKE_PRESETS, ...favs];
  // A color picked with "Any color…" that isn't in the list still gets its own swatch.
  if (chosen !== "natural" && !options.some(([, v]) => same(v, chosen))) options.push(["Your color", chosen]);
  box.innerHTML = "";
  let chosenName = "";
  for (const [name, value] of options) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = value === "natural"
      ? `conic-gradient(from 200deg, ${SUNRISE_FRAMES.map((f) => hex(f.rgb)).join(", ")}, ${hex(SUNRISE_FRAMES[0].rgb)})`
      : hex(value);
    const on = value === chosen || same(value, chosen);
    if (on) chosenName = name;
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", name);
    b.title = name;
    b.onclick = () => onPick(value);
    box.append(b);
  }
  // "Any color…" opens the phone's own color picker.
  const any = document.createElement("label");
  any.className = "swatch any"; any.title = "Any color…";
  any.innerHTML = `<span aria-hidden="true">+</span><input type="color" aria-label="Pick any color">`;
  const input = any.querySelector("input");
  input.value = chosen === "natural" ? "#ffaa50" : hex(chosen);
  input.onchange = () => onPick(input.value.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16)));
  box.append(any);
  if (nameEl) nameEl.textContent = chosenName;
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
  $("#powerLabel").textContent = state.on ? "On" : "Off";
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
    b.className = "effect"; b.textContent = name;
    b.onclick = () => {
      cancelFade();
      const sp = +$("#speed").value;
      send("color", state.proto.effect(code, sp));
      if (state.proto.speed) send("speed", state.proto.speed(sp));
      box.querySelectorAll(".effect").forEach((e) => e.setAttribute("aria-pressed", String(e === b)));
    };
    box.append(b);
  }
  // Only show the speed slider when this lamp type understands speed.
  const p = state.proto;
  $("#speed").closest(".field").hidden = !(p && (p.speed || p.effect.length > 1));
  $("#protoName").textContent = p ? p.name : "none";
}
function renderScenes() {
  const box = $("#scenes");
  for (const [name, rgb] of SCENES) {
    const b = document.createElement("button");
    b.className = "scene"; b.style.setProperty("--c", hex(rgb));
    b.innerHTML = `<span>${name}</span>`;
    b.onclick = () => { cancelFade(); setColor(rgb); };
    box.append(b);
  }
}
let editingFavs = false;
function renderFavs() {
  const favs = store.get("favs", []);
  const box = $("#favs");
  box.innerHTML = "";
  box.classList.toggle("editing", editingFavs);
  favs.forEach((rgb, i) => {
    const b = document.createElement("button");
    b.className = "fav"; b.style.background = hex(rgb);
    b.setAttribute("aria-label", (editingFavs ? "Delete saved color " : "Use saved color ") + hex(rgb));
    b.onclick = () => {
      if (editingFavs) { favs.splice(i, 1); store.set("favs", favs); if (!favs.length) editingFavs = false; renderFavs(); renderWakeColors(); }
      else { cancelFade(); setColor(rgb); }
    };
    box.append(b);
  });
  if (!editingFavs) {
    const add = document.createElement("button");
    add.className = "fav add"; add.textContent = "+"; add.setAttribute("aria-label", "Save current color");
    add.onclick = () => { favs.push(hsvToRgb(state.hsv)); store.set("favs", favs.slice(-12)); renderFavs(); renderWakeColors(); };
    box.append(add);
  }
  const edit = $("#favEdit");
  edit.hidden = !favs.length;
  edit.textContent = editingFavs ? "Done" : "Edit";
  $("#favHint").hidden = !editingFavs;
}

// ---------- color wheel ----------
const wheel = $("#wheel");
const ctx = wheel.getContext("2d");
let wheelImg = null;
function buildWheel() {
  const dpr = window.devicePixelRatio || 1;
  const size = Math.round(wheel.clientWidth * dpr);
  if (!size) return; // hidden (another tab is showing)
  if (wheelImg && wheelImg.width === size) { drawWheel(); return; }
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
  try { await writeChar(opt._char, new Uint8Array(bytes)); } catch (e) { log("raw write failed: " + e.message); }
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
$("#connect").onclick = () => connect(false);
$("#connectAll").onclick = () => connect(true);
$("#demo").onclick = startDemo;
$("#power").onclick = () => { cancelFade(); setPower(!state.on); };
$("#bri").oninput = (e) => { cancelFade(); setBri(+e.target.value); };
$("#fadeCancel").onclick = cancelJob;
$("#favEdit").onclick = () => { editingFavs = !editingFavs; renderFavs(); };

// Bottom tabs
function showTab(name) {
  document.body.dataset.tab = name;
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.dataset.tab === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  store.set("tab", name);
  if (name === "color") requestAnimationFrame(buildWheel);
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => { showTab(b.dataset.tab); scrollTo({ top: 0, behavior: "smooth" }); }));
showTab(store.get("tab", "color"));

// Timer type switcher (Sunset / Sleep / Wake-up)
function showTimer(name) {
  document.querySelectorAll("[data-timer]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.timer === name)));
  document.querySelectorAll("[data-timer-panel]").forEach((p) => (p.hidden = p.dataset.timerPanel !== name));
  $("#phoneNote").hidden = name === "schedule";
  store.set("timerTab", name);
}
document.querySelectorAll("[data-timer]").forEach((b) => (b.onclick = () => showTimer(b.dataset.timer)));
showTimer(store.get("timerTab", "schedule"));
renderSchedule();

// Settings sheet
function openSettings() { const d = $("#advanced"); if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute("open", ""); }
$("#settingsBtn").onclick = openSettings;
$("#advanced").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$("#writeMode").value = store.get("writeMode", "auto");
$("#writeMode").onchange = (e) => {
  store.set("writeMode", e.target.value);
  log("write mode: " + e.target.value);
  if (state.proto) setPower(true);
};

if (!navigator.bluetooth) showUnsupported();
renderScenes(); renderFavs(); renderPower(); renderTimers();
new ResizeObserver(buildWheel).observe(wheel);
renderColor();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
