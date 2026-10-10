---
description: Echoes its arguments with plugin context
argument-hint: [words]
---

Echo request: $ARGUMENTS
First word: $0
Plugin root: ${CLAUDE_PLUGIN_ROOT}
Tool says: !`probe-tool`
