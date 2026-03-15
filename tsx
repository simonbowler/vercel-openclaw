#!/bin/sh
set -eu
exec node scripts/exec-local-bin.mjs tsx "$@"
