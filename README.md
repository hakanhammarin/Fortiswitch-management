# FortiSwitch Fleet Management

A small full-stack app for managing a fleet of FortiSwitch devices over SSH:
per-port visibility (PoE draw, VLAN, MAC table + LLDP neighbor, discovered device
names), desired-state config compliance against a YAML template with a diff view
and one-click enforcement, whitelisted port-level edits from the UI, switch
rename with hostname sync, and git-versioned config backups after every change.
Verified against real standalone FortiSwitch-108E-FPOE hardware (v7.4.9), not
just the bundled mock fleet.

## Architecture

```
backend/   Node.js (Express) API + SSH automation + SQLite + git-backed config backups
frontend/  React (Vite) single-page UI
```

- **SSH automation** (`backend/src/ssh/sshClient.js`): uses the `ssh2` npm package to
  open a password-authenticated interactive shell and drive the FortiSwitchOS CLI
  (`get`/`diagnose`/`show`, and `config .../ edit / set / next / end` blocks). This is
  the "sshpass equivalent" — no OS-level `sshpass` binary is needed; ssh2 supplies the
  password directly during the SSH handshake. `withSession()` keeps one persistent
  session open per poll/change and hands out a `send(commands)` function for as many
  sequential command batches as needed — real hardware has been observed to reject a
  *second* connection attempted right after the first one closes ("All configured
  authentication methods failed"), even with valid credentials, so batches that need
  more than one round of commands (e.g. reading port state, then live PoE draw per
  port) share a single connection rather than reconnecting. Every session also
  disables FortiSwitchOS's `--More--` pager (`config system console` / `set output
  standard`) up front — without it, any command whose output exceeds the pty's
  default 24 rows (e.g. the full running-config) hangs waiting for a keypress that
  never comes.
- **ssh2 patch** (`backend/patches/ssh2+*.patch`, applied via `patch-package` on
  `npm install`): a real FortiSwitch advertises the OpenSSH `hostkeys-00@openssh.com`
  extension; ssh2's automatic `hostkeys-prove` reply to it causes the device to kill
  the session on the next channel request. This app never verifies host keys via
  `known_hosts` anyway, so the patch just skips that round-trip.
- **Mock switch fleet** (`backend/src/ssh/mockSwitchServer.js`): a small SSH server
  emulating the real CLI grammar (`fortiSwitchCli.js`, `mockSwitchState.js`) so the
  whole stack can be developed and demoed without hardware. Point the app at real
  switches instead by registering their real host/port/credentials — the SSH/parsing
  code path is identical either way.
- **Parsing** (`backend/src/ssh/fortiSwitchParser.js`): turns raw CLI text into
  structured port/PoE/VLAN/MAC/LLDP/ARP/global-config data. FortiSwitchOS has no
  single command that reports admin-status + PoE + native-vlan + allowed-vlans
  together, so port state is assembled from several reads and merged
  (`mergePortState`) — see `fortiSwitchDevice.js` for the exact command list.
- **Discovery** (`backend/src/services/arpDiscoveryService.js`): tries the switch's
  own ARP table first (`get system arp` — authoritative for its routed VLANs), then
  this backend host's local ARP/neighbor cache (macOS `arp -a` or Linux `ip neigh
  show`), then mDNS (`avahi-browse`)/NetBIOS (`nbtscan`) for hostnames. A MAC with no
  real answer anywhere is recorded as such (no IP/hostname) — never a fabricated
  placeholder.
- **Desired state** (`backend/src/services/desiredStateService.js` +
  `backend/src/templates/*.yaml`): YAML rules matched per-port by port name or
  description regex, plus a `global:` section for site-wide settings (`switch
  global`/`auto-network`/`system dns`/`system ntp`/`system global` admin-lockout),
  diffed against cached switch state. Every violation carries `field`/`current`/
  `expected` (not just a message), which both drives the UI's diff view and lets
  `enforceSwitch()` know exactly what to push. Templates are created/edited from the
  UI (Templates page) or the API; a switch picks one via its `role_template`, which
  can be changed any time (Compliance tab, or "Add switch").
- **Enforce** (`backend/src/services/configService.js` → `enforceSwitch`): applies
  every *enforceable* violation from the current compliance report in one pass (one
  `config switch interface`/`physical-port` block per drifted port, plus one call for
  drifted global settings), re-polls, backs up, and returns the resulting compliance
  report. Violations with no single correct value (e.g. `nativeVlanIn`'s "one of
  [...]") are skipped. This pushes real config to the device — the UI confirms before
  firing.
- **Port-level changes from the UI** (`configService.js` → `changePort`): a narrower,
  separate path — only `nativeVlan`, `poeEnabled`, and `description` can be changed
  from the "Edit port" modal, regardless of what a template allows Enforce to touch.
  `nativeVlan` is validated against the union of the port's own `allowed-vlans` and
  any formal switch-level VLAN objects, plus VLAN 1 (FortiSwitchOS's default/untagged
  VLAN, which is independent of `allowed-vlans` and always valid). Every change is
  SSH-applied, the switch is re-polled, and the new running-config is committed.
- **Backups** (`backend/src/services/backupService.js`): a dedicated git repository
  (separate from this app's own source repo) under `backend/data/config-backups/`,
  one directory per switch name, one commit per applied change (plus a baseline
  commit on first successful poll). Text that doesn't look like a real config dump
  (a captured CLI error, e.g. from a bad command) is rejected rather than committed.
  Viewing/diffing a backup resolves the file path from that specific commit's own
  git tree, not the switch's *current* name, so history stays reachable across a
  rename.
- **Switch rename** (`configService.js` → `renameSwitch`): sets the device's
  hostname over SSH first (`config system global` / `set hostname`, restricted to
  letters/digits/`-`/`_`), then updates this app's own name only once the device
  confirms it — the two never drift apart.
- **10mila_monitoring import** (`backend/src/services/inventoryImportService.js`):
  read-only. It only reads `cis*.json` from a local checkout of
  `hakanhammarin/10mila_monitoring` and lists CIs whose name matches the switch
  naming convention (default `^SW\d+`) as import candidates. Importing a candidate
  only writes a row to this app's own switch inventory — nothing is ever written
  back to that repository.

## Running locally (no Docker)

```bash
cd backend
npm install                 # also applies the ssh2 patch via postinstall
cp .env.example .env
# edit .env: set CREDENTIAL_ENCRYPTION_KEY (openssl rand -hex 32)

# Optional: demo fleet of 3 simulated switches
npm run mock-switch &     # starts mock SSH endpoints on :2201-2203
npm run seed-dev           # registers them in the app's inventory

npm start                  # API on :4000

cd ../frontend
npm install
npm run dev                 # UI on :5173, proxies /api to :4000
```

Open http://localhost:5173.

## Running with Docker

```bash
export CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32)
docker compose up --build
# add --profile demo to also start the 3 simulated switches on :2201-2203
```

Frontend: http://localhost:8080. Backend API: http://localhost:4000.

Config backups persist in the `backend_data` named volume (`docker compose exec
backend git -C /app/data/config-backups log` to inspect history).

## Pointing at real FortiSwitch hardware

1. In the UI, "Add switch" (or import from 10mila_monitoring) with the switch's
   real management IP, SSH port, and admin credentials, picking a desired-state
   template from the dropdown (or leave it on `default` and create/assign one later).
2. The backend polls every switch every `POLL_INTERVAL_MS` (default 30s) using the
   real `sshClient.js`/`fortiSwitchDevice.js` path — the same code the mock fleet uses.
   The exact command set (verified against real FortiSwitchOS 7.4.9) is:
   `get system status`, `diagnose switch physical-ports summary`, `show
   full-configuration switch physical-port`, `show full-configuration switch
   interface`, `get switch vlan`, `diagnose switch mac-address list`, `get system
   arp`, `get switch lldp neighbors-summary`, `show` (full config, for the backup
   snapshot), plus one `diagnose switch poe status <port>` per PoE-enabled port.
3. If your FortiSwitchOS CLI output differs (firmware version differences,
   localized field names, a switch model with a different physical-port range,
   etc.), adjust the regexes in `fortiSwitchParser.js` — keep the mock CLI
   (`fortiSwitchCli.js`/`mockSwitchState.js`) in sync with any format change so the
   demo fleet and the unit tests (`backend/test/fortiSwitchParser.test.js`, which use
   real captured output as fixtures) keep meaning something.
4. For real ARP/mDNS/NetBIOS discovery beyond the switch's own `get system arp`,
   run the backend on (or with routed access to) the switches' management LAN and
   install `avahi-utils` / `nbtscan` if you want broadcast-based hostname resolution.

## Security notes

- Switch SSH passwords are encrypted at rest (AES-256-GCM) with a key from
  `CREDENTIAL_ENCRYPTION_KEY`; never commit a real `.env`.
- The port-change API enforces a field whitelist server-side (not just in the UI)
  and rejects characters that could break out of a quoted CLI argument. Enforce
  pushes a broader set of fields, but only ones an assigned template's author
  explicitly declared as `expect`ed — nothing arbitrary.
- This app has no built-in user authentication — it's meant to run on a trusted
  internal network/VPN. Put it behind your own SSO/reverse-proxy auth if exposing
  it more broadly.
- The 10mila_monitoring integration is read-only by construction: it only ever
  calls `fs.readFileSync` on that repo's inventory files.

## Repository layout

```
backend/
  patches/                       persisted ssh2 patch (see Architecture, applied via postinstall)
  src/
    db.js, repositories.js        SQLite schema + data access
    crypto.js                     credential encryption
    ssh/                          SSH client (withSession), mock switch, CLI parser, device commands
    services/                     polling, discovery, desired-state, config apply/enforce/rename, backups, import
    routes/                       Express routes
    templates/                     default.yaml (generic), fs108-default.yaml (FS108 baseline)
  test/                           unit tests - parser tests use real captured CLI output as fixtures
frontend/
  src/
    pages/                        Dashboard, SwitchDetail (Ports/Compliance/Backups/Audit tabs), Templates, Import
    components/                   AddSwitchModal, EditPortModal
    api/client.js                 fetch wrapper for the backend API
```
