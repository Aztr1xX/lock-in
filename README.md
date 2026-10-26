# Lock In

A study focus app. Open it, press **Start**, study.

- `src/` – the web app (Vite + TypeScript, React code built with Preact). Everything is saved in the browser on your PC.
- `extension/` – **Lock In Blocker** for Chrome. Blocks Twitch, game sites and non-study YouTube while a session runs.
- `helper/` – **Lock In game closer** for Windows. Closes Steam, Minecraft and Valorant mid-session. Run `Install.cmd`.

The app talks to the extension with window messages, and the extension talks to the game closer on `127.0.0.1:47821`.

## Develop

```
npm install
npm run dev
python3 pack.py   # rebuilds public/lock-in-blocker.zip and public/lock-in-game-closer.zip
npm run build
```
