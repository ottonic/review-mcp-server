default:
	just --list

setup:
	npm install

dev:
	npm run dev

build:
	npm run build

test:
	npm test

# Native toolchain integration tests. Review is a pure SQLite/Node server and has
# none today, so this is a documented no-op (`--passWithNoTests`).
test-integration:
	npm run test:integration

typecheck:
	npm run typecheck

lint:
	npm run lint

fmt:
	npm run fmt

fmt-check:
	npm run fmt:check

check: fmt-check lint typecheck test

clean:
	rm -rf dist
