# FortiSwitch Fleet Management

A small full-stack app for managing a fleet of FortiSwitch devices over SSH:
per-port visibility (PoE, VLAN, MAC table, discovered device names), desired-state
config compliance against a YAML template, whitelisted port-level edits from the
UI, and git-versioned config backups after every change.

## Architecture

```
backend/   Node.js (Express) API + SSH automation + SQLite + git-backed config backups
frontend/  React (Vite) single-page UI
```

- **SSH automation** (`backend/src/ssh/sshClient.js`): uses the `ssh2` npm package to
  open a password-authenticated interactive shell and drive the FortiSwitchOS CLI
  (`get`/`diagnose`/`show`, and `config switch interface` / `edit` / `set` / `next` / `end`
  blocks). This is the "sshpass equivalent" — no OS-level `sshpass` binary is needed;
  ssh2 supplies the password directly during the SSH handshake. It talks the same
  protocol to real FortiSwitchOS hardware.
- **Mock switch fleet** (`backend/src/ssh/mockSwitchServer.js`): since this environment
  has no real FortiSwitch hardware to test against, a small SSH server emulates the
  same CLI grammar (`src/ssh/fortiSwitchCli.js`, `mockSwitchState.js`) so the whole
  stack can be developed and demoed end-to-end. Point the app at real switches by
  registering their real host/port/credentials instead — the SSH/parsing code is
  unchanged either way.
- **Parsing** (`backend/src/ssh/fortiSwitchParser.js`): turns raw CLI text into
  structured port/PoE/VLAN/MAC data, independent of mock vs. real transport.
- **Discovery** (`backend/src/services/arpDiscoveryService.js`): tries real ARP
  (`ip neigh show`), mDNS (`avahi-browse`) and NetBIOS (`nbtscan`) lookups first (this
  works out of the box if the backend runs on the switches' LAN); falls back to a
  clearly-labeled simulated mapping otherwise (e.g. in this sandbox, which has no LAN).
- **Desired state** (`backend/src/services/desiredStateService.js` +
  `backend/src/templates/default.yaml`): YAML rules matched per-port by port name or
  description regex, diffed against cached switch state, to produce a compliance report.
- **Port-level changes** (`backend/src/services/configService.js`): only `nativeVlan`,
  `poeEnabled`, and `description` can be changed from the UI — everything else on a
  port (trunking, STP, LACP, etc.) is out of reach by design. VLANs must already exist
  on the switch. Every change is SSH-applied, the switch is re-polled, and the new
  running-config is committed.
- **Backups** (`backend/src/services/backupService.js`): a dedicated git repository
  (separate from this app's own source repo) under `backend/data/config-backups/`,
  one directory per switch, one commit per applied change (plus a baseline commit on
  first successful poll).
- **10mila_monitoring import** (`backend/src/services/inventoryImportService.js`):
  read-only. It only reads `cis*.json` from a local checkout of
  `hakanhammarin/10mila_monitoring` and lists CIs whose name matches the switch
  naming convention (default `^SW\d+`) as import candidates. Importing a candidate
  only writes a row to this app's own switch inventory — nothing is ever written
  back to that repository.

## Running locally (no Docker)

```bash
cd backend
npm install
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
   real management IP, SSH port, and admin credentials.
2. The backend polls every switch every `POLL_INTERVAL_MS` (default 30s) using the
   real `sshClient.js`/`fortiSwitchDevice.js` path — same code the mock fleet uses.
3. If your FortiSwitchOS CLI output differs from what `fortiSwitchParser.js` expects
   (firmware version differences, localized field names, etc.), adjust the regexes
   there — the mock server's CLI grammar was modeled on standard FortiSwitchOS
   (`get switch physical-port-summary`, `diagnose switch physical-ports poe-status`,
   `get switch vlan`, `diagnose switch mac-address list`, `show full-configuration switch`).
4. For real ARP/mDNS/NetBIOS discovery, run the backend on (or with routed access to)
   the switches' management LAN and install `avahi-utils` / `nbtscan` if you want
   broadcast-based hostname resolution beyond plain ARP.

## Security notes

- Switch SSH passwords are encrypted at rest (AES-256-GCM) with a key from
  `CREDENTIAL_ENCRYPTION_KEY`; never commit a real `.env`.
- The port-change API enforces a field whitelist server-side (not just in the UI)
  and rejects characters that could break out of a quoted CLI argument.
- This app has no built-in user authentication — it's meant to run on a trusted
  internal network/VPN. Put it behind your own SSO/reverse-proxy auth if exposing
  it more broadly.
- The 10mila_monitoring integration is read-only by construction: it only ever
  calls `fs.readFileSync` on that repo's inventory files.

## Repository layout

```
backend/
  src/
    db.js, repositories.js        SQLite schema + data access
    crypto.js                     credential encryption
    ssh/                          SSH client, mock switch, CLI parser
    services/                     polling, discovery, desired-state, config apply, backups, import
    routes/                       Express routes
    templates/default.yaml        example desired-state template
frontend/
  src/
    pages/                        Dashboard, SwitchDetail, Templates, Import
    components/                   AddSwitchModal, EditPortModal
    api/client.js                 fetch wrapper for the backend API
```
