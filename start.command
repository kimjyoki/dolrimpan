#!/bin/bash
# 판교 술상 돌림판 실행기.
#
# 유튜브 임베드는 file:// 로 열면 error 153 으로 거부당한다(출처가 없어서).
# 반드시 http:// 로 띄워야 뮤직비디오가 재생된다.

cd "$(dirname "$0")" || exit 1

PORT=8777
while lsof -i :$PORT >/dev/null 2>&1; do PORT=$((PORT + 1)); done

echo "판교 술상 돌림판 → http://localhost:$PORT"
echo "종료하려면 이 창에서 Ctrl+C"
echo

python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM

sleep 1
open "http://localhost:$PORT/index.html"

wait $SERVER
