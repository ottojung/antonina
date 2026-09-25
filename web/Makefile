.PHONY: build

build:
	npm ci --no-audit --no-fund
	npm run build
	rm -rf build
	mv dist build
