# Glow: a better controller for Bluetooth sunset lamps

A small, ad-free web app that replaces apps like meRGBW for cheap RGB/sunset lamps.
It runs in the browser using Web Bluetooth, so there's nothing to install from an app store.
You can add it to your home screen and it works like an app.

## Features

- Smooth color wheel and brightness slider (no lag while you drag)
- One-tap scenes: Sunset, Golden hour, Dusk, Candle, Night light…
- Saved favorite colors (long-press one to remove it)
- **Sunset fade**: slowly dims to a deep red, then turns off
- **Sunrise wake-up**: slowly brightens from red to warm white
- **Sleep timer**: turns the lamp off after N minutes
- Built-in light effects with a speed control
- Reconnects automatically if the lamp drops out
- Advanced panel: pick the lamp's protocol by hand, or send raw bytes to try new commands

## Supported lamps

The lamp type is detected automatically from its Bluetooth services:

| Protocol | Bluetooth name usually starts with | Service / characteristic |
|---|---|---|
| ELK-BLEDOM family | `ELK-BLEDOM`, `MELK`, `LEDBLE`, `duoCo` | `FFF0` / `FFF3` |
| Triones family | `Triones`, `LEDnet`, `QHM-` | `FFD5` / `FFD9` |

If your lamp connects but says the language is unknown, open **Advanced**. It lists the
characteristics the lamp accepts writes on, so you can try commands. New protocols go in
[`protocols.js`](protocols.js).

## How to use

1. **Fully close the meRGBW app.** A lamp only talks to one app at a time.
2. Open the app's GitHub Pages link in:
   - **Android, Windows, Mac or ChromeOS:** Chrome or Edge
   - **iPhone / iPad:** the free **Bluefy** browser (Safari doesn't support Web Bluetooth)
3. Tap **Connect to lamp** and choose your lamp from the list.
4. Optional: use *Add to Home screen* from the browser menu so it opens like a normal app.

Sunset/sunrise fades run in the page, so keep it open while a fade runs (the screen stays awake).

## Run locally

```bash
python -m http.server 8000
```

Then open http://localhost:8000. Web Bluetooth needs `https://` or `localhost`.
