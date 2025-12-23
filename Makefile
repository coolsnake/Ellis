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
	@echo "Cleaning corrupted Solana platform tools cache..."
	@bash -c '\
		if [ -d "$$HOME/.cache/solana" ]; then \
			echo "Removing corrupted Solana cache..."; \
			rm -rf $$HOME/.cache/solana 2>/dev/null || true; \
		fi; \
		if [ -d "/root/.cache/solana" ] && [ "$$(id -u)" = "0" ]; then \
			echo "Removing root Solana cache..."; \
			rm -rf /root/.cache/solana 2>/dev/null || true; \
		fi; \
		echo "Anchor will automatically reinstall platform tools during build."'
	@echo "Note: Anchor.toml specifies version 0.30.1"
	@bash -c '\
		ANCHOR_INSTALLED=false; \
		if command -v anchor >/dev/null 2>&1; then \
			ANCHOR_VER=$$(anchor --version 2>/dev/null | head -1 || echo "unknown"); \
			echo "Found Anchor: $$ANCHOR_VER"; \
			if echo "$$ANCHOR_VER" | grep -q "0.30.1"; then \
				ANCHOR_INSTALLED=true; \
			fi; \
		fi; \
		if [ "$$ANCHOR_INSTALLED" != "true" ] && command -v avm >/dev/null 2>&1; then \
			echo "Attempting to install Anchor 0.30.1 via AVM..."; \
			if avm install 0.30.1 2>&1 | grep -v "already installed"; then \
				avm use 0.30.1 && ANCHOR_INSTALLED=true || true; \
			else \
				avm use 0.30.1 && ANCHOR_INSTALLED=true || true; \
			fi; \
		fi; \
		if [ "$$ANCHOR_INSTALLED" != "true" ] && command -v cargo >/dev/null 2>&1; then \
			echo "Attempting to install Anchor 0.30.1 via cargo (without --locked to allow dependency updates)..."; \
			if ! CARGO_NET_GIT_FETCH_WITH_CLI=true cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.30.1 --force 2>&1 | head -50; then \
				echo "Anchor 0.30.1 installation failed (likely due to Rust 1.83+ compatibility)."; \
				echo "Installing Anchor 0.32.1 as fallback (program code uses anchor-lang 0.30.1)..."; \
				CARGO_NET_GIT_FETCH_WITH_CLI=true cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.32.1 --locked --force 2>&1 | head -50 || \
				echo "Warning: Anchor installation failed. Build will attempt with available Anchor version."; \
			fi; \
		fi'
	@echo "Installing npm dependencies..."
	cd arb-router && npm ci --legacy-peer-deps
	@echo "Removing old Cargo.lock to regenerate with Anchor 0.32.1..."
	@rm -f arb-router/Cargo.lock 2>/dev/null || true
	@echo "Building Anchor program (using Anchor 0.32.1)..."
	@echo "Attempting to update Solana platform tools (current Rust 1.75 is too old)..."
	@bash -c '\
		if command -v solana >/dev/null 2>&1; then \
			SOLANA_VER=$$(solana --version 2>/dev/null | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1 || echo ""); \
			echo "Current Solana version: $$SOLANA_VER"; \
			echo "Note: Solana 1.18.26+ has Rust 1.77+ in platform tools."; \
			if [ -n "$$SOLANA_VER" ]; then \
				MAJOR=$$(echo $$SOLANA_VER | cut -d. -f1); \
				MINOR=$$(echo $$SOLANA_VER | cut -d. -f2); \
				PATCH=$$(echo $$SOLANA_VER | cut -d. -f3); \
				if [ $$MAJOR -lt 1 ] || ([ $$MAJOR -eq 1 ] && [ $$MINOR -lt 18 ]) || ([ $$MAJOR -eq 1 ] && [ $$MINOR -eq 18 ] && [ $$PATCH -lt 26 ]); then \
					echo "Warning: Solana version is too old. Platform tools may have Rust 1.75."; \
					echo "Try updating Solana: solana-install update || (sh -c \"$$(curl -sSfL https://release.solana.com/stable/install)\")"; \
				fi; \
			fi; \
		fi; \
		rm -rf ~/.cache/solana/platform-tools 2>/dev/null || true; \
		rm -rf /root/.cache/solana/platform-tools 2>/dev/null || true; \
		echo "Cleared platform tools cache. Anchor will download newer version."'
	cd arb-router && bash -c '\
		rustup override set stable 2>/dev/null || true; \
		if command -v avm >/dev/null 2>&1; then avm use 0.30.1 || true; fi; \
		anchor build'

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


