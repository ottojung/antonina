.PHONY: build

build:
	npm ci --prefix web --no-audit --no-fund
	npm run build
	rm -rf build
	mv web/dist build
