#!/bin/zsh
# One command to run Work Rights Q&A on this Mac for a demo or interview:
#   ./demo.sh
# Starts the API (port 8787) and the website (port 5173) against the local
# Postgres knowledge base, then opens the browser. Ctrl+C stops both.
cd "$(dirname "$0")"
# Stop anything already on the two ports (by port, not by name: a name pattern
# can match the shell running this very script).
lsof -ti:8787 -ti:5173 | xargs kill 2>/dev/null
npm run -s server &
API=$!
npm run -s web &
WEB=$!
trap "kill $API $WEB 2>/dev/null; exit" INT TERM
for i in {1..30}; do curl -s localhost:8787/api/health >/dev/null && curl -s localhost:5173 >/dev/null && break; sleep 1; done
echo "\nWork Rights Q&A is running → http://localhost:5173  (Ctrl+C to stop)\n"
open http://localhost:5173
wait
