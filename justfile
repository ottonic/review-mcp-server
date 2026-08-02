default:
	just --list

setup:
	npm install

dev:
	npm run dev

fmt:
	npx --yes prettier@3 --check src test package.json

lint:
	npm run typecheck

test:
	npm test

check: fmt lint test
	@echo "Check completed"

build:
	npm run build

clean:
	rm -rf dist
