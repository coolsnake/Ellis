# Lockstone Makefile

.PHONY: build build-all backend frontend arb arb-router check-solana-tools deploy start stop restart status svc-backend svc-arb svc-nginx logs start-logs arb-router-devnet arb-router-mainnet arb-router-test arb-router-airdrop clean clean-cargo clean-tmp

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

check-solana-tools: ## Check/install Solana platform tools (Python-based, avoids curl TLS issues)
	@echo "=== Checking Solana Platform Tools ==="
	@bash -c '\
		export PATH="$$HOME/.local/share/solana/install/active_release/bin:$$PATH"; \
		PLATFORM_TOOLS_DIR="$$HOME/.local/share/solana/install/active_release/platform-tools"; \
		ANCHOR_CACHE_DIR="$$HOME/.cache/solana/platform-tools"; \
		\
		# Check system time (critical for SSL/TLS) \
		CURRENT_TIME=$$(date +%s); \
		MIN_TIME=1577836800; \
		MAX_TIME=1893456000; \
		if [ $$CURRENT_TIME -lt $$MIN_TIME ] || [ $$CURRENT_TIME -gt $$MAX_TIME ]; then \
			echo "⚠ WARNING: System time may be incorrect (current: $$CURRENT_TIME)"; \
			echo "  SSL/TLS connections will fail. Fix with: sudo ntpdate -s time.nist.gov"; \
		fi; \
		\
		# First check if Solana CLI exists anywhere in PATH \
		if command -v solana >/dev/null 2>&1; then \
			SOLANA_PATH=$$(command -v solana); \
			echo "✓ Found Solana CLI at: $$SOLANA_PATH"; \
			SOLANA_DIR=$$(dirname "$$SOLANA_PATH"); \
			export PATH="$$SOLANA_DIR:$$PATH"; \
		fi; \
		\
		# Check common installation locations \
		for SOLANA_HOME in "$$HOME/.local/share/solana" "/root/.local/share/solana" "/usr/local/share/solana"; do \
			if [ -d "$$SOLANA_HOME/install/active_release/bin" ]; then \
				export PATH="$$SOLANA_HOME/install/active_release/bin:$$PATH"; \
				echo "✓ Found Solana installation at: $$SOLANA_HOME"; \
				break; \
			fi; \
		done; \
		\
		# Check if platform tools exist \
		if cargo build-sbf --version >/dev/null 2>&1; then \
			echo "✓ Platform tools already installed: $$(cargo build-sbf --version 2>&1 | head -1)"; \
			\
			# Find actual platform tools directory \
			BUILD_SBF_PATH=$$(command -v cargo-build-sbf 2>/dev/null || command -v cargo build-sbf 2>/dev/null || echo ""); \
			if [ -n "$$BUILD_SBF_PATH" ]; then \
				BUILD_SBF_DIR=$$(dirname "$$BUILD_SBF_PATH"); \
				ACTUAL_TOOLS_DIR=$$(dirname "$$BUILD_SBF_DIR")/platform-tools; \
				if [ -d "$$ACTUAL_TOOLS_DIR" ]; then \
					PLATFORM_TOOLS_DIR="$$ACTUAL_TOOLS_DIR"; \
					echo "✓ Found platform tools at: $$PLATFORM_TOOLS_DIR"; \
				fi; \
			fi; \
			\
			# Ensure Anchor can find them by creating symlink if needed \
			if [ -d "$$PLATFORM_TOOLS_DIR" ] && [ ! -e "$$ANCHOR_CACHE_DIR" ]; then \
				echo "Creating symlink for Anchor to find platform tools..."; \
				mkdir -p "$$HOME/.cache/solana" 2>/dev/null || true; \
				ln -sf "$$PLATFORM_TOOLS_DIR" "$$ANCHOR_CACHE_DIR" 2>/dev/null || true; \
				echo "✓ Symlink created: $$ANCHOR_CACHE_DIR -> $$PLATFORM_TOOLS_DIR"; \
			fi; \
		else \
			echo "✗ Platform tools not found."; \
			\
			# Check if Solana CLI exists but platform tools are missing \
			if command -v solana-install >/dev/null 2>&1; then \
				echo "Found solana-install, attempting to install platform tools..."; \
				solana-install init 2.0.0 2>&1 || echo "⚠ solana-install failed"; \
				export PATH="$$HOME/.local/share/solana/install/active_release/bin:$$PATH"; \
				if cargo build-sbf --version >/dev/null 2>&1; then \
					echo "✓ Platform tools installed via solana-install"; \
				else \
					echo "⚠ solana-install completed but tools not accessible, trying Python script..."; \
				fi; \
			fi; \
			\
			# If still not found, try Python installer \
			if ! cargo build-sbf --version >/dev/null 2>&1; then \
				echo "Installing via Python script..."; \
				if ! python3 scripts/install-solana-platform-tools.py; then \
					echo ""; \
					echo "ERROR: Failed to install platform tools"; \
					echo ""; \
					echo "TROUBLESHOOTING:"; \
					echo "  1. Check system time: date (should be current)"; \
					echo "     Fix with: sudo ntpdate -s time.nist.gov"; \
					echo "  2. If Solana CLI is already installed: solana-install init 2.0.0"; \
					echo "  3. Check if Solana exists: which solana"; \
					echo "  4. Check installation: ls -la ~/.local/share/solana/install/active_release/bin/"; \
					echo ""; \
					exit 1; \
				fi; \
				export PATH="$$HOME/.local/share/solana/install/active_release/bin:$$PATH"; \
				# Check again, but don't fail if still not found - Anchor will download them \
				if cargo build-sbf --version >/dev/null 2>&1; then \
					echo "✓ Platform tools installed and verified"; \
				else \
					echo "⚠ Platform tools not found, but Solana CLI is installed."; \
					echo "  Anchor will download platform tools automatically during build."; \
					echo "  Proceeding with build..."; \
				fi; \
			fi; \
			\
			# Create symlink for Anchor after installation \
			if [ -d "$$PLATFORM_TOOLS_DIR" ] && [ ! -e "$$ANCHOR_CACHE_DIR" ]; then \
				echo "Creating symlink for Anchor to find platform tools..."; \
				mkdir -p "$$HOME/.cache/solana" 2>/dev/null || true; \
				ln -sf "$$PLATFORM_TOOLS_DIR" "$$ANCHOR_CACHE_DIR" 2>/dev/null || true; \
				echo "✓ Symlink created: $$ANCHOR_CACHE_DIR -> $$PLATFORM_TOOLS_DIR"; \
			fi; \
		fi'

arb-router: check-solana-tools ## Build Anchor arb-router program (requires Agave 2.x / Solana 2.x)
	@echo "=== Building arb-router program ==="
	@echo ""
	@echo "REQUIREMENTS:"
	@echo "  - Agave/Solana CLI 2.x with platform tools (Rust 1.79+)"
	@echo "  - Anchor CLI 0.32.1+"
	@echo ""
	@bash -c '\
		export PATH="$$HOME/.local/share/solana/install/active_release/bin:$$PATH"; \
		if ! command -v anchor >/dev/null 2>&1; then \
			echo "ERROR: Anchor CLI not found."; \
			echo "Install with: cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.32.1"; \
			exit 1; \
		fi; \
		ANCHOR_VER=$$(anchor --version 2>/dev/null | head -1 || echo "unknown"); \
		echo "Found Anchor CLI: $$ANCHOR_VER"; \
		if command -v solana >/dev/null 2>&1; then \
			SOLANA_VER=$$(solana --version 2>/dev/null | head -1 || echo "unknown"); \
			echo "Found Solana CLI: $$SOLANA_VER"; \
		else \
			echo "WARNING: Solana CLI not found in PATH."; \
		fi; \
		if ! cargo build-sbf --version >/dev/null 2>&1; then \
			echo "ERROR: Platform tools not found even after check-solana-tools."; \
			echo "Try manually: solana-install init 2.0.0"; \
			echo "Then ensure PATH includes: $$HOME/.local/share/solana/install/active_release/bin"; \
			exit 1; \
		fi; \
		echo "Found platform tools: $$(cargo build-sbf --version 2>&1 | head -1)"'
	@echo "Installing npm dependencies..."
	cd arb-router && npm ci --legacy-peer-deps
	@echo "Removing old Cargo.lock..."
	@rm -f arb-router/Cargo.lock 2>/dev/null || true
	@echo "Pinning indexmap to Rust 1.79 compatible version..."
	cd arb-router && cargo generate-lockfile && cargo update indexmap --precise 2.5.0
	@echo "Building Anchor program..."
	@bash -c '\
		export PATH="$$HOME/.local/share/solana/install/active_release/bin:$$PATH"; \
		PLATFORM_TOOLS_DIR="$$HOME/.local/share/solana/install/active_release/platform-tools"; \
		ANCHOR_CACHE_DIR="$$HOME/.cache/solana/platform-tools"; \
		\
		# Ensure Anchor can find platform tools via symlink \
		if [ -d "$$PLATFORM_TOOLS_DIR" ] && [ ! -e "$$ANCHOR_CACHE_DIR" ]; then \
			mkdir -p "$$HOME/.cache/solana" 2>/dev/null || true; \
			ln -sf "$$PLATFORM_TOOLS_DIR" "$$ANCHOR_CACHE_DIR" 2>/dev/null || true; \
			echo "✓ Linked Anchor cache to platform tools: $$ANCHOR_CACHE_DIR -> $$PLATFORM_TOOLS_DIR"; \
		fi; \
		\
		# Set environment variables to prevent Anchor from downloading platform tools \
		export SOLANA_PLATFORM_TOOLS_DIR="$$PLATFORM_TOOLS_DIR"; \
		export ANCHOR_PLATFORM_TOOLS_DIR="$$ANCHOR_CACHE_DIR"; \
		\
		cd arb-router && anchor build'

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


