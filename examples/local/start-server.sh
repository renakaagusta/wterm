#!/bin/bash
export PATH="/Users/renakaagusta/.nvm/versions/node/v20.19.6/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/Users/renakaagusta"
export NODE_ENV="development"
export PORT="3001"
export HOST="127.0.0.1"
export WTERM_PASSWORD="wterm123"
export TOKEN_SECRET="my-super-secret-key-for-wterm"

cd /Users/renakaagusta/Documents/project/wterm/examples/local
exec node_modules/.bin/tsx server.ts
