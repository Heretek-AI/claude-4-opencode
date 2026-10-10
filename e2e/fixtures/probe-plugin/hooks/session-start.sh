#!/usr/bin/env bash
# Adds context through the JSON protocol.
cat <<'JSON'
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "PROBE_SESSION_CONTEXT: always answer in haiku." } }
JSON
