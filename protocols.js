// Bluetooth protocol drivers for common cheap RGB lamp controllers.
// Each driver builds raw byte arrays; the app takes care of writing them.

const u = (n) => `0000${n.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;
const clamp = (v, lo = 0, hi = 255) => Math.max(lo, Math.min(hi, Math.round(v)));

// MeRGBW sunset lamps (Tsrarey and similar): 55 cmd FF len payload checksum.
// Protocol worked out by github.com/King1704G and github.com/davidanthoff (ha-mergbw).
function mergbwFrame(cmd, payload = []) {
  const body = [0x55, cmd, 0xff, payload.length + 5, ...payload];
  let s = body.reduce((a, b) => a + b, 0);
  while (s > 0xff) s = (s >> 8) + (s & 0xff);
  return [...body, ~s & 0xff];
}

// Day bitmask used by the lamp: Monday = bit 0 … Sunday = bit 6.
export const daysToMask = (days) => days.reduce((m, on, i) => m | (on ? 1 << i : 0), 0);
export const maskToDays = (mask) => [0, 1, 2, 3, 4, 5, 6].map((i) => !!(mask & (1 << i)));

export const PROTOCOLS = [
  {
    id: "mergbw",
    name: "MeRGBW sunset lamp",
    service: u(0xfff0),
    write: u(0xfff3),
    notify: u(0xfff4),
    namePrefixes: ["Sunset", "MeRGBW"],
    // Ask for status; a MeRGBW lamp answers on FFF4 with a frame starting 0x56 0x00.
    probe: mergbwFrame(0x00),
    probeReply: (bytes) => bytes[0] === 0x56 && bytes[1] === 0x00,
    // The lamp ignores color/brightness while off, and wakes at its last brightness,
    // so dim to 1% before switching off to avoid a bright flash next time.
    offPrelude: () => mergbwFrame(0x05, [1]),
    power: (on) => mergbwFrame(0x01, [on ? 1 : 0]),
    color: (r, g, b) => mergbwFrame(0x03, [clamp(r), clamp(g), clamp(b)]),
    brightness: (pct) => mergbwFrame(0x05, [clamp(pct, 1, 100)]),
    effect: (code) => mergbwFrame(0x06, [code]),
    // Built-in on/off schedule, stored on the lamp. Format from the meRGBW app
    // (see github.com/launxy/MeRGBW-Linux, PROTOCOL.md).
    status: () => mergbwFrame(0x00),
    syncTime: (d = new Date()) => {
      const y = d.getFullYear();
      const isoWeekday = d.getDay() || 7; // 1 = Monday … 7 = Sunday
      return mergbwFrame(0x0c, [y >> 8, y & 0xff, d.getMonth() + 1, d.getDate(),
        d.getHours(), d.getMinutes(), d.getSeconds(), isoWeekday]);
    },
    // on/off: { enabled, h, m, days: [mon, tue, wed, thu, fri, sat, sun] }
    timer: (on, off) => mergbwFrame(0x0a, [
      on.enabled ? 1 : 0, on.h, on.m, daysToMask(on.days),
      off.enabled ? 1 : 0, off.h, off.m, daysToMask(off.days),
    ]),
    // Status reply: 56 00 FF 0F <power> <bri> <on: set h m week> <off: set h m week> <checksum>
    parseSchedule: (b) => {
      if (b.length < 14 || (b[0] !== 0x56 && b[0] !== 0x55) || b[1] !== 0x00) return null;
      const alarm = (i) => ({ enabled: b[i] === 1, h: b[i + 1], m: b[i + 2], days: maskToDays(b[i + 3]) });
      return { power: b[4] === 1, on: alarm(6), off: alarm(10) };
    },
    effects: [
      ["Fantasy", 0x80], ["Green prairie", 0x81], ["Forest", 0x82], ["Sunrise", 0x83],
      ["Ghost", 0x84], ["Midsummer", 0x85], ["Tropical twilight", 0x86], ["Disco", 0x87],
      ["Alarm", 0x88], ["Aurora", 0x89], ["Scene 0x8A", 0x8a], ["Savanna", 0x8b],
      ["Lake Placid", 0x8c], ["Neon", 0x8d], ["Sundowner", 0x8e], ["Blue star", 0x8f],
      ["Red rose", 0x90], ["Scene 0x91", 0x91], ["Scene 0x92", 0x92], ["Autumn", 0x93],
    ],
  },
  {
    id: "elk",
    name: "ELK-BLEDOM / MELK / duoCo / Lotus",
    service: u(0xfff0),
    write: u(0xfff3),
    namePrefixes: ["ELK", "MELK", "ELK-BLE", "LEDBLE", "duoCo"],
    power: (on) => (on ? [0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef]
                       : [0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef]),
    color: (r, g, b) => [0x7e, 0x00, 0x05, 0x03, clamp(r), clamp(g), clamp(b), 0x00, 0xef],
    brightness: (pct) => [0x7e, 0x00, 0x01, clamp(pct, 0, 100), 0x00, 0x00, 0x00, 0x00, 0xef],
    effect: (code) => [0x7e, 0x00, 0x03, code, 0x03, 0x00, 0x00, 0x00, 0xef],
    speed: (pct) => [0x7e, 0x00, 0x02, clamp(pct, 0, 100), 0x00, 0x00, 0x00, 0x00, 0xef],
    effects: [
      ["Rainbow jump", 0x87], ["Rainbow fade", 0x89], ["Rainbow strobe", 0x88],
      ["Red breathe", 0x8b], ["Orange breathe", 0x8c], ["Pink breathe", 0x91],
      ["Purple breathe", 0x90], ["Blue breathe", 0x8e], ["White breathe", 0x93],
      ["Red/Blue fade", 0x8a], ["Strobe", 0x94],
    ],
  },
  {
    id: "triones",
    name: "Triones / HappyLighting / LEDnet",
    service: u(0xffd5),
    write: u(0xffd9),
    namePrefixes: ["Triones", "LEDnet", "QHM", "Dream", "HappyLighting"],
    hardwareBrightness: false,
    power: (on) => (on ? [0xcc, 0x23, 0x33] : [0xcc, 0x24, 0x33]),
    color: (r, g, b) => [0x56, clamp(r), clamp(g), clamp(b), 0x00, 0xf0, 0xaa],
    effect: (code, speedPct = 50) => [0xbb, code, clamp(31 - (speedPct / 100) * 30, 1, 31), 0x44],
    effects: [
      ["Rainbow fade", 0x25], ["Red breathe", 0x26], ["Green breathe", 0x27],
      ["Blue breathe", 0x28], ["Yellow breathe", 0x29], ["Purple breathe", 0x2b],
      ["White breathe", 0x2c], ["Red/Green fade", 0x2d], ["Rainbow strobe", 0x30],
      ["Rainbow jump", 0x38],
    ],
  },
];

// Every service we might want to touch must be declared up front for Web Bluetooth.
export const ALL_SERVICES = [
  ...new Set([
    ...PROTOCOLS.map((p) => p.service),
    u(0x3519), u(0xffe0), u(0xffe5), u(0xfff0), u(0xffd0), u(0xffd5), u(0xee01), u(0xae00),
    u(0x1800), u(0x1801), u(0x180a),
  ]),
];

export const shortUuid = (uuid) =>
  /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.test(uuid) ? "0x" + uuid.slice(4, 8).toUpperCase() : uuid;
