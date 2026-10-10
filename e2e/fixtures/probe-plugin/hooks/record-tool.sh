#!/usr/bin/env bash
# No matcher: runs for every tool call and records the name the hook was given.
jq -c '{ tool_name, tool_input }' >> "$CLAUDE_PROJECT_DIR/.probe-tools.jsonl"
