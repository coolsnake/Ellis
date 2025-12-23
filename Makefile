# Lockstone Makefile

.PHONY: build build-all backend frontend arb arb-router deploy start stop restart status svc-backend svc-arb svc-nginx logs start-logs arb-router-devnet arb-router-mainnet arb-router-test arb-router-airdrop clean clean-cargo clean-tmp

WWW_DIR ?= /var/www/lockstone

# Helius RPC configuration
HELIUS_API_KEY ?= 4673beb7-dcca-4942-91ac-c69babdf1f02
HELIUS_DEVNET_RPC = https://devnet.helius-rpc.com/?api-key=$(HELIUS_API_KEY)
HELIUS_MAINNET_RPC = https://mainnet.helius-rpc.com/?api-key=$(HELIUS_API_KEY)

build: backend frontend arb arb-router ## Build backend, frontend, arb-rs, and arb-router (use sudo)

build-all: build ## Alias for build (kept for backward compatibility)

backend: ## Build backend
	cd backend && npm ci --legacy-peer-deps --include=dev && npm run build

frontend: ## Build frontend and sync to $(WWW_DIR)
	cd frontend && npm ci --legacy-peer-deps --include=dev && npm run build
	sudo mkdir -p "$(WWW_DIR)"
	sudo rsync -a --delete frontend/dist/ "$(WWW_DIR)/"

arb: ## Build Rust arb-rs
	cd arb-rs && cargo build --release

arb-router: ## Build Anchor arb-router program
	@echo "=== Building arb-router program ==="
	@echo "Note: Using anchor-lang 0.30.1 (compatible with Solana platform tools Rust 1.75)"
	@bash -c '\
		if command -v anchor >/dev/null 2>&1; then \
			ANCHOR_VER=$$(anchor --version 2>/dev/null | head -1 || echo "unknown"); \
			echo "Found Anchor CLI: $$ANCHOR_VER"; \
		else \
			echo "Anchor CLI not found. Please install with: cargo install --git https://github.com/coral-xyz/anchor anchor-cli"; \
			exit 1; \
		fi'
	@echo "Installing npm dependencies..."
	cd arb-router && npm ci --legacy-peer-deps
	@echo "Generating Cargo.lock with Rust 1.75.0 (creates v3 format compatible with platform tools)..."
	@bash -c '\
		rm -f arb-router/Cargo.lock 2>/dev/null || true; \
		if rustup run 1.75.0 cargo --version >/dev/null 2>&1; then \
			cd arb-router && rustup run 1.75.0 cargo generate-lockfile; \
			echo "Cargo.lock generated with Rust 1.75.0 (v3 format)"; \
		else \
			echo "Rust 1.75.0 not installed. Installing..."; \
			rustup install 1.75.0; \
			cd arb-router && rustup run 1.75.0 cargo generate-lockfile; \
			echo "Cargo.lock generated with Rust 1.75.0 (v3 format)"; \
		fi'
	@echo "Building Anchor program..."
	cd arb-router && anchor build

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

clean-cargo: ## Clean Cargo caches and temporary build files
	@echo "Cleaning Cargo cache..."
	cargo clean 2>/dev/null || true
	rm -rf ~/.cargo/registry/cache 2>/dev/null || true
	rm -rf /tmp/cargo-install* 2>/dev/null || true
	@echo "Cargo cache cleaned."

clean-tmp: ## Clean temporary files
	@echo "Cleaning temporary files..."
	rm -rf /tmp/cargo-install* 2>/dev/null || true
	rm -rf /tmp/rustc* 2>/dev/null || true
	@echo "Temporary files cleaned."

clean: clean-cargo clean-tmp ## Clean all build artifacts and caches
	@echo "All caches cleaned."


