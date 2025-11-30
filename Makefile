# Lockstone Makefile

.PHONY: build build-all backend frontend arb arb-router deploy start stop restart status svc-backend svc-arb svc-nginx logs start-logs arb-router-devnet arb-router-mainnet arb-router-test arb-router-airdrop

WWW_DIR ?= /var/www/lockstone

# Helius RPC configuration
HELIUS_API_KEY ?= 4673beb7-dcca-4942-91ac-c69babdf1f02
HELIUS_DEVNET_RPC = https://devnet.helius-rpc.com/?api-key=$(HELIUS_API_KEY)
HELIUS_MAINNET_RPC = https://mainnet.helius-rpc.com/?api-key=$(HELIUS_API_KEY)

build: backend frontend arb ## Build backend, frontend, and arb-rs (use sudo)

build-all: build arb-router ## Build everything (run arb-router without sudo)

backend: ## Build backend
	cd backend && npm ci --legacy-peer-deps --include=dev && npm run build

frontend: ## Build frontend and sync to $(WWW_DIR)
	cd frontend && npm ci --legacy-peer-deps --include=dev && npm run build
	sudo mkdir -p "$(WWW_DIR)"
	sudo rsync -a --delete frontend/dist/ "$(WWW_DIR)/"

arb: ## Build Rust arb-rs
	cd arb-rs && cargo build --release

arb-router: ## Build Anchor arb-router program (run WITHOUT sudo)
	cd arb-router && npm ci --legacy-peer-deps && anchor build

arb-router-devnet: arb-router ## Deploy arb-router to devnet
	cd arb-router && ANCHOR_PROVIDER_URL="$(HELIUS_DEVNET_RPC)" anchor deploy --provider.cluster devnet

arb-router-mainnet: arb-router ## Deploy arb-router to mainnet
	cd arb-router && ANCHOR_PROVIDER_URL="$(HELIUS_MAINNET_RPC)" anchor deploy --provider.cluster mainnet

arb-router-test: ## Run arb-router tests on devnet
	cd arb-router && ANCHOR_PROVIDER_URL="$(HELIUS_DEVNET_RPC)" anchor test --provider.cluster devnet

arb-router-airdrop: ## Request devnet airdrop (2 SOL)
	solana airdrop 2 --url "$(HELIUS_DEVNET_RPC)"

deploy: build ## Build and restart services + reload nginx
	sudo systemctl restart lockstone-backend lockstone-arb
	sudo systemctl reload nginx

start: ## Start backend, arb and nginx
	sudo systemctl start lockstone-backend lockstone-arb
	sudo systemctl start nginx
	@if [ -t 1 ]; then bash scripts/logdash.sh; else echo "Services started. Run 'make logs' to open the dashboard."; fi

stop: ## Stop backend, arb and nginx
	sudo systemctl stop lockstone-backend lockstone-arb
	sudo systemctl stop nginx

restart: ## Restart backend, arb and nginx
	sudo systemctl restart lockstone-backend lockstone-arb
	sudo systemctl restart nginx

status: ## Show service statuses
	sudo systemctl status lockstone-backend lockstone-arb nginx | cat

svc-backend: ## Restart backend only
	sudo systemctl restart lockstone-backend

svc-arb: ## Restart arb only
	sudo systemctl restart lockstone-arb

svc-nginx: ## Reload nginx only
	sudo systemctl reload nginx

logs: ## Open tmux dashboard for backend and arb logs
	bash scripts/logdash.sh

start-logs: start ## Start services then open tmux dashboard
	@if [ -t 1 ]; then bash scripts/logdash.sh; else echo "Non-interactive shell detected; skipping log dashboard"; fi


