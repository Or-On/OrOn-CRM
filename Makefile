.DEFAULT_GOAL := help

PYTHON ?= python
RUNNER := $(PYTHON) scripts/dev.py

.PHONY: help doctor bootstrap voice-bootstrap voice-up voice-check voice-down dev stop ps logs migrate migration-check migration-graph migration-sql db-contract-check db-verify-offline db-verify-live seed lint format typecheck test verify

help: ## Show the supported developer commands.
	@$(RUNNER) help

doctor: ## Check local tool versions, Docker, and required ports.
	@$(RUNNER) doctor

bootstrap: ## Idempotently sync dependencies, start PostgreSQL, migrate, seed, and verify health.
	@$(RUNNER) bootstrap

voice-bootstrap: ## Install the heavy retained Pipecat/audio group with providers disabled.
	@$(RUNNER) voice-bootstrap

voice-up: ## Start and read-only verify the optional local LiveKit/SIP control plane.
	@$(RUNNER) voice-up

voice-check: ## Verify the SIP control plane without creating provider state.
	@$(RUNNER) voice-check

voice-down: ## Stop only the optional local LiveKit/SIP/Redis services.
	@$(RUNNER) voice-down

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

migration-graph: ## Verify and print the canonical Alembic graph without PostgreSQL.
	@$(RUNNER) migration-graph

migration-sql: ## Generate deterministic PostgreSQL upgrade SQL under .artifacts/db/.
	@$(RUNNER) migration-sql

db-contract-check: ## Check the schema manifest, RLS, extensions, indexes, and SQL safety.
	@$(RUNNER) db-contract-check

db-verify-offline: ## Run all repository-controlled Phase 2A database checks.
	@$(RUNNER) db-verify-offline

db-verify-live: ## Run Phase 2B tests against an explicit isolated PostgreSQL 18.6 URL.
	@$(RUNNER) db-verify-live

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
