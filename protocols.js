// Bluetooth protocol drivers for common cheap RGB lamp controllers.
// Each driver builds raw byte arrays; the app takes care of writing them.

const u = (n) => `0000${n.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;
const clamp = (v, lo = 0, hi = 255) => Math.max(lo, Math.min(hi, Math.round(v)));

export const PROTOCOLS = [
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
    u(0xffe0), u(0xffe5), u(0xfff0), u(0xffd0), u(0xffd5), u(0xee01), u(0xae00),
    u(0x1800), u(0x1801), u(0x180a),
  ]),
];

export const shortUuid = (uuid) =>
  /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.test(uuid) ? "0x" + uuid.slice(4, 8).toUpperCase() : uuid;
