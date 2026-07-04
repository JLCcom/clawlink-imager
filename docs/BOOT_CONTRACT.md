# Boot injection contract — Imager ↔ ClawLink OS

This document defines the **plugin boundary** between ClawLink Imager and
ClawLink OS: the files this app writes to the SD card's boot partition after
flashing, and what ClawLink OS is expected to do with them on first boot.
Same spirit as [`API_CONTRACT.md`](API_CONTRACT.md) — if this contract and
the actual OS-side script drift apart, the device silently fails to come up
headless. Changes here require a matching issue in `JLCcom/clawlink`.

## 0. Correction (2026-07-04) — armbian_first_run.txt does NOT do accounts/SSH

An earlier version of this doc, and the main repo's
`docs/production/OrangePi_Edge_Setup_Guide.md`, claimed `armbian_first_run.txt`
supports `FR_root_password` / `FR_user_name` / `FR_user_password` /
`FR_user_shell`. **That's wrong** — checked directly against upstream
(`armbian/build`, `packages/bsp/armbian_first_run.txt.template`, unchanged
since 2018): this file only ever had networking fields
(`FR_net_*`/ `FR_general_delete_this_file_after_completion`). There is no
account/password/SSH handling in it, and never was.

Armbian's real mechanism for that is a **different** file:
`/root/.not_logged_in_yet` with `PRESET_ROOT_PASSWORD` / `PRESET_USER_NAME` /
`PRESET_USER_PASSWORD` / `PRESET_LOCALE` / `PRESET_TIMEZONE` etc. (see
https://docs.armbian.com/User-Guide_Autoconfig/). If unset, the corresponding
setting is asked **interactively** at first login — this is where the "root
password wizard" people run into actually comes from.

The catch: `/root/.not_logged_in_yet` lives on the **ext4 root partition**,
not the FAT32 boot partition. A cross-platform desktop imager (Windows/macOS/
Linux) cannot reliably write to an ext4 partition without bundling extra
drivers — Windows and macOS have no native ext4 support. So this app writing
that file directly is not a realistic option (see §1 for what to do instead).

So, corrected two-layer model:

| Layer | File | Partition | Owner | Job |
|---|---|---|---|---|
| 1 — networking | `armbian_first_run.txt` | boot (FAT, cross-platform writable) | Armbian upstream format, but see §1 — **not currently used by this project** | WiFi/ethernet/static IP only |
| 2 — everything ClawLink-specific | `clawlink.conf` | boot (FAT) | ClawLink (`clawlink-firstboot.service`) | serial activation, edge install, **and — proposed — root/user/SSH setup** |

## 1. Layer 1 — `armbian_first_run.txt`: not needed for this project

`clawlink-firstboot.sh` (main repo) already has its own WiFi bring-up
(`nmcli`/`wpa_supplicant`, driven by `clawlink.conf`'s `WIFI_SSID`/`WIFI_PW`).
Since `armbian_first_run.txt`'s only job is the same networking setup, using
both would mean two independent things fighting over the same WiFi
interface. **Recommendation: don't introduce `armbian_first_run.txt` at all
for this project** — keep ClawLink's own WiFi bring-up as the single path,
fix its shell-escaping bug ([#6](https://github.com/JLCcom/clawlink-imager/issues/6)),
and let this stay boot-partition-only so the Imager never needs ext4 access.

This reverses what [#7](https://github.com/JLCcom/clawlink-imager/issues/7)
originally proposed (write `armbian_first_run.txt` with account fields that,
per the correction above, don't exist in that file) — see the comment left
on that issue.

## 1b. So who sets root/user password and enables SSH?

Since the Imager can't safely touch the ext4 root partition, and
`armbian_first_run.txt` doesn't do accounts anyway, the only place left that
can do this **and already runs as root, on-device, after boot** is
`clawlink-firstboot.sh` itself. Proposed (main-repo work, not this repo):

- Set the root password and create the `clawlink` user directly
  (`chpasswd`, `useradd`), matching the existing production standard
  (`docs/production/OrangePi_Edge_Setup_Guide.md`: root/`1234`,
  `clawlink`/`1234`).
- `systemctl enable --now ssh` explicitly instead of assuming it's already on
  — needs verification either way (see §4).
- Write or clear `/root/.not_logged_in_yet` so Armbian's own interactive
  first-login wizard never fires, now that the accounts it would have asked
  about already exist.

This is **not yet filed as an issue** — needs a new issue in
`JLCcom/clawlink`, cross-linked here once created.

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
SSH_PASSWORD=
SSH_PUBKEY=
```

| Field | Required | Notes |
|---|---|---|
| `CONTRACT_VERSION` | yes | Integer, written as `1`. Lets the OS-side script detect an Imager version it doesn't understand instead of silently misparsing. Imager side done (`src/main.js`) — OS-side read is [`JLCcom/clawlink#612`](https://github.com/JLCcom/clawlink/issues/612), not yet implemented there. |
| `SERIAL` | yes | If empty, `clawlink-firstboot.sh` exits without activating. |
| `HW_MODEL` | yes | One of the board keys in `docs/API_CONTRACT.md`'s manifest. |
| `WIFI_SSID` / `WIFI_PW` | no | Skipped if the board has wired ethernet. |
| `SSH_PASSWORD` | no | RPi-Imager-style per-device override for the `clawlink` user's password. Imager side done (#13 — UI field + written to `clawlink.conf`). If unset, `clawlink-firstboot.sh` should fall back to the fixed fleet default (`1234`) per §1b — OS-side consumption is `JLCcom/clawlink#617`, not yet implemented there. |
| `SSH_PUBKEY` | no | A public key to install into `~clawlink/.ssh/authorized_keys`, letting a user skip password auth entirely. Same status as `SSH_PASSWORD` — Imager side done, OS side pending (`JLCcom/clawlink#617`). |

**Why these two are optional, not required:** most of this fleet is
provisioned by the ClawLink team itself using the fixed standard credentials
(§1b) — the override exists for end users who want to flash their own
device with their own credentials, same idea as Raspberry Pi Imager's
"custom user/password + SSH key" advanced options.

**Escaping rule (fixed — [#6](https://github.com/JLCcom/clawlink-imager/issues/6)):**
because the OS side does `source "$CONF"`, every value is wrapped in single
quotes with any embedded `'` escaped (standard shell quoting), e.g. a WiFi
password of `it's$afe` is written as `WIFI_PW='it'\''s$afe'`. Implemented as
`shellQuote()` in `src/main.js` (`boot:inject`), applied to every field.
Verified locally: values containing `$`, backticks, `$()`, spaces, and `'`
all round-trip through `source` unchanged with no shell execution.

## 3. Execution order

Only one file is consumed at first boot (per §1, `armbian_first_run.txt` is
not used):

1. `clawlink-firstboot.service` (`After=network-online.target`,
   `ConditionPathExists=/boot/clawlink.conf`) reads `clawlink.conf`.
2. It should — proposed, see §1b — set root/user password, create the
   `clawlink` user, and enable SSH **first**, before anything network-related,
   so that even if a human tries to log in mid-boot they never hit Armbian's
   interactive wizard.
3. Then: connects WiFi, activates the serial against `clawlinkai.io`,
   installs Docker, runs `install.sh` (edge install), then disables itself.

There's a subtlety worth calling out even with `armbian_first_run.txt` out
of the picture: `clawlink-firstboot.service` only waits on
`network-online.target`, with no ordering guarantee relative to whatever
early-boot account-setup step ends up owning §1b. Once §1b is implemented,
its ordering relative to `clawlink-firstboot.service` needs to be made
explicit, not assumed (tracked in
[`JLCcom/clawlink#612`](https://github.com/JLCcom/clawlink/issues/612), which
already covers a related ordering question).

## 4. Known gaps (tracked as issues)

- Root/user password + SSH enable is not yet done by `clawlink-firstboot.sh`
  or anything else in the pipeline — filed as
  [`JLCcom/clawlink#617`](https://github.com/JLCcom/clawlink/issues/617)
  (see §1b). This is the single biggest remaining gap between "flash with
  this app" and "boots with zero touch," replacing the old (incorrect)
  `armbian_first_run.txt` framing.
- ~~Layer 2 (`clawlink.conf`) values are not shell-escaped before being
  written~~ — fixed, [#6](https://github.com/JLCcom/clawlink-imager/issues/6).
- ~~`CONTRACT_VERSION` not written by the Imager~~ — fixed, #10. OS-side read
  still pending — [`JLCcom/clawlink#612`](https://github.com/JLCcom/clawlink/issues/612).
- Windows `sd:write` (#8) is now implemented in pure JS (`xz-decompress` +
  direct write to the `\\.\PhysicalDriveN` path from `drivelist`, no bundled
  `7z`/`dd` binaries) and `boot:inject` looks up the real drive letter via
  `drivelist` instead of assuming `D:\`. **Not yet verified on real Windows
  hardware** — this repo's rule requires that before calling it done.
- Unverified: whether Armbian Minimal ships with OpenSSH enabled out of the
  box independent of any first-run file, as the ops doc assumes — this is
  image packaging, not a first-run mechanism, so it should hold regardless,
  but hasn't been confirmed against the actual `Armbian_community_24.11.0_*`
  base images this project pins.
- Unverified: whether any `apt-get`/`dpkg` step inside `install.sh` or
  `clawlink-firstboot.sh`'s Docker install can hit an interactive `debconf`
  prompt (e.g. `tzdata`, `locales`) and hang first boot with no TTY attached
  — needs `DEBIAN_FRONTEND=noninteractive` verification. **Not yet filed.**

See the issue tracker for the concrete work items derived from this
document — this file should stay a description of the contract as it
exists, with gaps called out, not a task list.

## 5. Change procedure

- Adding an optional field to either file is safe — parsers should ignore
  unknown fields.
- Removing a field, changing its meaning, or changing the file format
  breaks devices silently. Bump `CONTRACT_VERSION`, update this doc, and
  open a matching issue in `JLCcom/clawlink` for the OS-side script.
