#!/bin/bash
# Minimal stand-in for an AI agent: reads a line, "works" briefly, answers.
name="${1:-agent}"
echo "[$name] ready"
while IFS= read -r line; do
  sleep 0.3
  echo "[$name] done: ${line}"
done
