# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Windows photo booth kiosk ("Prints of Darkness" haunt). A guest types their name and email at a keyboard, the booth shoots three photos on a Canon DSLR, builds a bordered/logo'd strip, shows the result on an OBS-driven display, and emails the photos. It is deployed on a single Windows machine (user `pod`, repo at `C:\Users\pod\winbooth`).

## Commands

Run from the repo root (npm workspaces):

- `npm run dev`: NestJS API with watch (`nest start --watch` in `packages/api`)
- `npm run build`: compile the API to `packages/api/dist`
- `npm run start:prod`: run the compiled API (`node dist/main`)
- `start-photobooth.bat`: production start; launches both processes under pm2 using `ecosystem.config.cjs` (`parsec-server` via `start-parsec.bat`, `photo-booth-api` via `start-api.bat`)

There are no tests or linters configured.

`parsec-server/` is a git submodule (`UWStout/nodejs-canon-control-server`). Run `git submodule update --init` to populate it. It is started with `npm run server:dev` inside that folder.

## Architecture

Four separate processes cooperate:

1. **PARSEC** (`parsec-server`, https://localhost:3000, self-signed cert): Node wrapper around the Canon EDSDK. The API calls it over HTTP (`/camera/`, `/camera/:i/trigger`, `/camera/:i/SaveTo`, `/camera/:i/liveView`). `camera.service.ts` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` process-wide for this.
2. **NestJS API** (`packages/api`, port 3001): orchestrates everything and also serves `public/` statically, plus capture images at `/camera/captures`.
3. **OBS Studio**: the guest-facing display. The API drives it through obs-websocket (`obs.service.ts`) by switching scenes and setting image sources.
4. **OBS Python script** (`packages/api/src/obs/python/kiosk-obs.py`): loaded inside OBS. It captures global keystrokes with `pynput`, renders the name/email prompt into the OBS text source `Kiosk Input`, and POSTs to `http://localhost:3001/session/start`. F5 resets it, and so does the OBS hotkey `kiosk_reset` that the script registers. The API fires that hotkey through `TriggerHotkeyByName` when someone presses the dashboard's reset button (`POST /session/reset-kiosk`).

### Session flow (`session/session.service.ts`)

Only one session runs at a time, guarded by the `busy` flag. `POST /session/start` returns immediately, and `runSession` continues asynchronously:

open camera (SaveTo=Host) → OBS scene `Countdown` → for each of 3 shots: Home Assistant webhook, 3-2-1-"BOO!" countdown, trigger PARSEC, copy the image into `CAPTURES_DIR/<sessionId>/` → `buildStrip` (sharp: per-photo border + `assets/sign.png` logo saved as `*-processed.jpg`, plus a vertical strip in `STRIPS_DIR/<sessionId>/`) → OBS scene `Delivery` → 5s → OBS scene `Idle` → email via Resend (`delivery.service.ts`).

Session history and the error log are kept in memory only, so they are lost on restart.

### How photo capture works

PARSEC writes downloaded images into `parsec-server/public/images` and overwrites the same filename each time. `PARSECSession.takePicture` triggers the shutter, then polls that directory for a changed mtime and waits until the file size is stable before copying it. The directory is resolved relative to `process.cwd()` (`../../parsec-server/...`), so the API must be started from `packages/api`. The comment in that file about `os.tmpdir()`/tempy is outdated.

### Events and WebSocket

`SessionService` emits internal `EventEmitter2` events: `session-started`, `countdown`, `flash`, `preview`, `stateChange`, and `error-alert`. `gateway/booth.gateway.ts` rebroadcasts each one to socket.io clients. A new event needs both an `emit` in the service and an `@OnEvent` handler in the gateway.

### Frontend pages (`public/`)

- `display.html`: operator dashboard. It uses the REST endpoints `/session/health`, `/session/history`, `/session/errors/*`, `/session/resend-email/:id`, `/session/restart-service/:service` (pm2 restart), and `/session/reset-kiosk`. It also listens to the gateway's socket events.
- `countdown.html` and `idle.html` are intended for use as OBS browser sources.

### OBS contract

These names are hard-coded and must exist in the OBS scene collection:

- Scenes: `Idle`, `Countdown`, `Delivery`
- Sources: `photo-1`, `photo-2`, `photo-3`, `strip-image`, `Kiosk Input`
- Hotkey: `kiosk_reset`, registered by `kiosk-obs.py`

`updateImageSource` checks the input kind and sets `url` for browser sources or `file` for image sources. All OBS requests go through `ObsService.call()`, which reconnects, applies a 5s timeout, and retries once on transport failure. A 20s heartbeat keeps the connection alive. Keep new OBS calls on that path.

## Configuration gotchas

- Env is loaded through `dotenv/config` from the cwd (`packages/api/.env`); see `.env.example`. All `.env*` files except `.env.example` are gitignored.
- Config is read inconsistently. Some code uses namespaced keys from `config/app.config.ts` (`app.capturesDir`, `app.obs.*`, `app.homeAssistant.webhookUrl`). Other code reads raw env names (`PARSEC_URL`, `RESEND_API_KEY`, `FROM_EMAIL`). With `registerAs('app')`, a namespaced key has to be read with the `app.` prefix, or `ConfigService.get` silently returns undefined.
- Several Windows paths are hard-coded rather than taken from config: `public/` and the captures dir in `main.ts`, the logo path in `buildStrip`, the PARSEC host/port in `camera.controller.ts`, and the `C:\Users\pod\winbooth` paths in the `.bat` files and `ecosystem.config.cjs`. Running anywhere other than the kiosk machine requires adjusting these.
