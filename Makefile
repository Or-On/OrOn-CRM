.DEFAULT_GOAL := help

PYTHON ?= python
RUNNER := $(PYTHON) scripts/dev.py

.PHONY: help doctor bootstrap dev stop ps logs migrate migration-check seed lint format typecheck test verify

help: ## Show the supported developer commands.
	@$(RUNNER) help

doctor: ## Check local tool versions, Docker, and required ports.
	@$(RUNNER) doctor

bootstrap: ## Idempotently sync dependencies, start PostgreSQL, migrate, seed, and verify health.
	@$(RUNNER) bootstrap

dev: ## Run the current host-development processes with real providers disabled.
	@$(RUNNER) dev

stop: ## Stop the local Compose services without deleting data.
	@$(RUNNER) stop

ps: ## Show local Compose service state.
	@$(RUNNER) ps

logs: ## Follow local Compose logs.
	@$(RUNNER) logs

migrate: ## Upgrade the sole Alembic lineage to head.
	@$(RUNNER) migrate

migration-check: ## Require one Alembic head and a database at that head.
	@$(RUNNER) migration-check

seed: ## Apply the idempotent fictional Phase 1 development seed.
	@$(RUNNER) seed

lint: ## Check formatting, lint, and repository architecture policy.
	@$(RUNNER) lint

format: ## Apply target-repository TypeScript and Python formatting.
	@$(RUNNER) format

typecheck: ## Run strict TypeScript and Python type checking.
	@$(RUNNER) typecheck

test: ## Run all target-repository unit tests.
	@$(RUNNER) test

verify: ## Run the consolidated acceptance suite, including database state and production build.
	@$(RUNNER) verify
