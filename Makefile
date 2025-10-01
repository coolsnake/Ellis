# Lockstone Makefile

.PHONY: build backend frontend arb deploy start stop restart status svc-backend svc-arb svc-nginx

WWW_DIR ?= /var/www/lockstone

build: backend frontend arb ## Build all components

backend: ## Build backend
	cd backend && npm ci --legacy-peer-deps --include=dev && npm run build

frontend: ## Build frontend and sync to $(WWW_DIR)
	cd frontend && npm ci --legacy-peer-deps --include=dev && npm run build
	sudo mkdir -p "$(WWW_DIR)"
	sudo rsync -a --delete frontend/dist/ "$(WWW_DIR)/"

arb: ## Build Rust arb-rs
	cd arb-rs && cargo build --release

deploy: build ## Build and restart services + reload nginx
	sudo systemctl restart lockstone-backend lockstone-arb
	sudo systemctl reload nginx

start: ## Start backend, arb and nginx
	sudo systemctl start lockstone-backend lockstone-arb
	sudo systemctl start nginx

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


