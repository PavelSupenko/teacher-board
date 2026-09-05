#!/bin/sh
# Double-click this file to set the board up. Nothing else is needed first.
# macOS may refuse the first time: right-click the file and choose Open.
cd "$(dirname "$0")"
sh scripts/install.sh
echo
printf 'Press Enter to close this window. '
read -r _
