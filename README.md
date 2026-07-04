# ClawLink Imager

Desktop app (Electron + React) that writes ClawLink OS images to an SD card.
Targets Windows / macOS / Linux. Same idea as Raspberry Pi Imager or
balenaEtcher — a general-purpose flashing tool, open source.

Separate repo from `JLCcom/clawlink` (the main core repo): the core repo
builds the OS image, this app only downloads that image and writes it to an
SD card. The two are connected only through a stable public contract:

- [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) — the cloud API this app
  calls (serial check, OS image manifest).
- [`docs/BOOT_CONTRACT.md`](docs/BOOT_CONTRACT.md) — the boot-partition
  files this app writes after flashing, and how ClawLink OS's first-boot
  service reads them to bring up networking and start the ClawLink edge
  service with no user interaction.

## Development

```bash
npm install
npm start        # Electron + React dev server
npm run electron:build:linux   # per-platform build (win/mac/linux)
```

## Status

`JLCcom/clawlink` repo issue [#485](https://github.com/JLCcom/clawlink/issues/485)
(epic) is the source of truth for progress. Core features like actually
writing to a real SD card have not been verified on real hardware yet — per
the no-hype rule, unverified features are marked "(in progress)" in the docs.

## Working rules

Before working in this repo, read (pinned) issue
[#1](https://github.com/JLCcom/clawlink-imager/issues/1) first — AI sessions
load it automatically via a SessionStart hook.
