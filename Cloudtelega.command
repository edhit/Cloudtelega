#!/bin/bash
# Запуск на macOS: двойной щелчок по этому файлу.
# Вся работа — в Cloudtelega.sh, чтобы не держать две копии одного и того же.
cd "$(dirname "$0")" || exit 1
exec bash ./Cloudtelega.sh
