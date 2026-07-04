# Boot injection contract — Imager ↔ ClawLink OS

This document defines the **plugin boundary** between ClawLink Imager and
ClawLink OS: the files this app writes to the SD card's boot partition after
flashing, and what ClawLink OS is expected to do with them on first boot.
Same spirit as [`API_CONTRACT.md`](API_CONTRACT.md) — if this contract and
the actual OS-side script drift apart, the device silently fails to come up
headless. Changes here require a matching issue in `JLCcom/clawlink`.

## 0. Why two files, not one

ClawLink OS images are built directly from **Armbian Minimal** base images
(`scripts/build-clawlinkos-image.sh` in the main repo). Armbian already has
its own first-boot config file, `armbian_first_run.txt`, which handles
account setup. If that file is missing, Armbian falls back to an
**interactive console wizard** (set root password, create a user) — which
blocks headless boot entirely on a device with no keyboard/monitor attached.

So there are two separate, independently-owned layers:

| Layer | File | Owner | Job |
|---|---|---|---|
| 1 — OS bootstrap | `armbian_first_run.txt` | Armbian (upstream, don't fork the format) | root/user account, password, SSH on |
| 2 — ClawLink bootstrap | `clawlink.conf` | ClawLink (`clawlink-firstboot.service`) | serial activation, edge install |

The Imager must write **both** files. Layer 1 must finish before layer 2
starts (see §3).

## 1. Layer 1 — `armbian_first_run.txt`

Written to the root of the boot partition. Format and field names are
Armbian's own (not ours to change) — see
https://docs.armbian.com/User-Guide_Getting-Started/ for the full field
list. ClawLink's production defaults, as already used for manual bakes
(`docs/production/OrangePi_Edge_Setup_Guide.md` in the main repo):

```ini
FR_general_delete_this_file_after_completion=1
FR_root_password=1234
FR_user_name=clawlink
FR_user_password=1234
FR_user_shell=bash
```

SSH is on by default on Armbian Minimal, so no `FR_ssh_*` fields are needed.

**Status: not yet written by this app** — today a human has to do this by
hand per the ops doc. Automating it is the single biggest gap between
"flash with this app" and "boots with zero touch." Tracked in
[#TBD](../../issues).

## 2. Layer 2 — `clawlink.conf`

Written to the root of the boot partition. Read by
`/usr/local/bin/clawlink-firstboot.sh` (main repo) via `source`, which is
why every value must be shell-safe.

```ini
CONTRACT_VERSION=1
SERIAL=CL-EO1-260600-000123
WIFI_SSID=my-wifi
WIFI_PW=my-password
HW_MODEL=rpi4
```

| Field | Required | Notes |
|---|---|---|
| `CONTRACT_VERSION` | yes | Integer. Lets the OS-side script detect an Imager version it doesn't understand instead of silently misparsing. Not yet implemented on either side — see §4. |
| `SERIAL` | yes | If empty, `clawlink-firstboot.sh` exits without activating. |
| `HW_MODEL` | yes | One of the board keys in `docs/API_CONTRACT.md`'s manifest. |
| `WIFI_SSID` / `WIFI_PW` | no | Skipped if the board has wired ethernet. |

**Escaping rule (currently violated — see §4):** because the OS side does
`source "$CONF"`, every value must be wrapped in single quotes with any
embedded `'` escaped (standard shell quoting), e.g. a WiFi password of
`it's$afe` must be written as `WIFI_PW='it'\''s$afe'`. The current Imager
code (`src/main.js` `boot:inject`) writes raw, unquoted values — a password
containing `$`, `` ` ``, or whitespace will either break the file or, worse,
run arbitrary shell as root during first boot. This is a correctness/safety
bug, not a template — fix before shipping to real users.

## 3. Execution order

Both files are consumed at first boot, in this order:

1. Armbian's own first-boot service reads `armbian_first_run.txt`, creates
   accounts, enables SSH, then deletes the file.
2. `clawlink-firstboot.service` (`After=network-online.target`) reads
   `clawlink.conf`, connects WiFi, activates the serial against
   `clawlinkai.io`, installs Docker, runs `install.sh` (edge install), then
   disables itself.

`clawlink-firstboot.service` does **not** currently declare an explicit
`After=` on Armbian's first-run unit — it only waits on
`network-online.target`. In practice this has worked because Armbian's
first-run finishes before network comes up, but it is an implicit ordering,
not a guaranteed one. Should be made explicit on the main-repo side.

## 4. Known gaps (tracked as issues)

- Layer 1 (`armbian_first_run.txt`) is not written by this app yet.
- Layer 2 values are not shell-escaped before being written.
- `CONTRACT_VERSION` is defined here but not yet read or written anywhere.
- WiFi bring-up is duplicated: Armbian's own `armbian_first_run.txt` also
  supports `FR_net_wifi_ssid` / `FR_net_wifi_key`; `clawlink-firstboot.sh`
  additionally rolls its own `nmcli`/`wpa_supplicant` logic. Worth
  consolidating onto one path instead of two independent WiFi bring-ups.

See the issue tracker for the concrete work items derived from this
document — this file should stay a description of the contract as it
exists, with gaps called out, not a task list.

## 5. Change procedure

- Adding an optional field to either file is safe — parsers should ignore
  unknown fields.
- Removing a field, changing its meaning, or changing the file format
  breaks devices silently. Bump `CONTRACT_VERSION`, update this doc, and
  open a matching issue in `JLCcom/clawlink` for the OS-side script.
