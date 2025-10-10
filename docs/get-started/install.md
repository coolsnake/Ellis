# Install

## Requirements
- Node.js 20 LTS (required)
- Git (recommended)
- Python 3 (only if building offline docs)
- Optional (live trading): Solana RPC URL, wallet keypair path

## Steps
```powershell
# 1) Install root deps and workspace apps
npm install

# 2) (Optional) Build backend and frontend bundles
npm run build
```

## Run services
- Both at once (recommended in dev):
```powershell
npm run dev
```
- Individually:
```powershell
npm run dev:backend
npm run dev:frontend
```

## Backend environment (optional for dev)
- SOLANA_RPC_URL: RPC endpoint
- WALLET_PATH: path to keypair JSON (for live trading)

Place env in `backend/.env` or your shell before starting.

## Offline docs (optional)
```powershell
py -m pip install --user mkdocs mkdocs-material
node scripts/build-docs.mjs
# Double-click site/index.html
```
