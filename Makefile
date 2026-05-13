.PHONY: release

release:
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "Working tree must be clean before releasing."; \
		exit 1; \
	fi
	npm version patch --no-git-tag-version
	@version="$$(node -p "require('./package.json').version")"; \
	git add package.json package-lock.json manifest.json versions.json; \
	git commit -m "$$version"; \
	git tag "$$version"; \
	git push origin HEAD; \
	git push origin "$$version"
