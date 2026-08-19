#!/usr/bin/env bash
# Поставить скилы human4ai туда, где их увидят агенты.
#
#   bash scripts/install-skills.sh            # copy в ~/.claude/skills и ~/.codex/skills
#
# Скилы — обычные каталоги с SKILL.md, поэтому «установка» это копирование.
# Claude Code и Codex читают их из своих каталогов; OpenClaw подхватывает
# ~/.claude/skills.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installed=0

for target in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
  # Ставим только туда, где агент реально есть: пустых каталогов не плодим.
  agent_home="$(dirname "$target")"
  [ -d "$agent_home" ] || continue

  mkdir -p "$target"
  for skill in "$ROOT"/skills/*/; do
    name="$(basename "$skill")"
    rm -rf "$target/$name"
    cp -R "$skill" "$target/$name"
    echo "  $name -> $target"
    installed=$((installed + 1))
  done
done

if [ "$installed" = "0" ]; then
  echo "Ни Claude Code, ни Codex на этой машине не найдены — скилы копировать некуда." >&2
  exit 1
fi

echo "Готово. Скилы: human4ai-setup, human4ai-mcp, human4ai-alice."
