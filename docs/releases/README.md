# Release notes

One file per tag, named exactly like the tag:

```
docs/releases/v0.5.0.md
```

The `release` workflow publishes it when the tag is pushed, and **fails if the
file is missing or empty**. Generated notes are not a fallback: they list what
changed and never state what was not verified.

State both. A release note that lists only features is incomplete.
