# Monitoring & Alerts

- Important metrics and thresholds
- Alerting recommendations

## Consolidated session log

- On backend shutdown, a consolidated log is written that merges recent UI logs and arb-rs logs.
- Paths
  - Backend session: `backend/logs/session.json` (or `${LOG_DIR}/session.json`)
  - Consolidated: `backend/logs/consolidated-session.json` (or `${LOG_DIR}/consolidated-session.json`)
  - Arb session (when arb runs separately): `${ARB_SESSION_JSON_PATH}` if set, otherwise `${ARB_LOG_DIR}/session.json`
- Env
  - `LOG_DIR`: base directory for backend logs
  - `CONSOLIDATED_LOG_MAX` (default 2000): max entries in consolidated output
  - `CONSOLIDATED_LOG_PATH` (optional): override output path
  - `ARB_SESSION_JSON_PATH` (optional): absolute path to arb-rs session.json
  - `ARB_LOG_DIR` (optional): directory containing arb-rs session.json
- Systemd
  - Ensure backend stops after arb so arb’s session is flushed before merge:
    - In `lockstone-backend.service`: `After=lockstone-arb.service`
    - Optionally: `Environment=ARB_SESSION_JSON_PATH=/var/www/lockstone/arb/logs/session.json`