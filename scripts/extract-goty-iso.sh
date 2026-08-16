#!/usr/bin/env bash
# Extract the 2014 GOTY / Collectors Edition ISO into a private loose tree.
# Does not commit or image the result.
set -euo pipefail

iso="${HL2_GOTY_ISO:-${1:-}}"
dest="${HL2_GOTY_ROOT:-/home/ted/.local/share/source-wasm/hl2-dvd}"

if [[ -z "${iso}" ]]; then
  for candidate in \
    "/home/ted/Desktop/Half-Life 2 Collectors Edition (2153).iso" \
    /inputs/iso/*.iso \
    /inputs/iso
  do
    if [[ -f "${candidate}" ]]; then iso="${candidate}"; break; fi
    if [[ -d "${candidate}" && -f "${candidate}/hl2/gameinfo.txt" ]]; then
      echo "already-extracted tree at ${candidate}"
      exit 0
    fi
  done
fi

if [[ -f "${dest}/hl2/gameinfo.txt" ]]; then
  echo "GOTY extract already present at ${dest}"
  exit 0
fi

if [[ -z "${iso}" || ! -f "${iso}" ]]; then
  echo "set HL2_GOTY_ISO to the 2014 GOTY / Collectors Edition ISO" >&2
  exit 2
fi

mkdir -p "${dest}"
work="${dest}.extract-work"
rm -rf "${work}"
mkdir -p "${work}"

if command -v 7z >/dev/null; then
  7z x -y -o"${work}" "${iso}" >/dev/null
elif command -v bsdtar >/dev/null; then
  bsdtar -C "${work}" -xf "${iso}"
else
  echo "need 7z or bsdtar to open the ISO" >&2
  exit 1
fi

cab="$(find "${work}" -iname 'HalfLife2.cab' -o -iname '*.cab' | head -n 1)"
if [[ -z "${cab}" ]]; then
  if [[ -f "${work}/hl2/gameinfo.txt" ]]; then
    cp -a "${work}/." "${dest}/"
    rm -rf "${work}"
    echo "copied loose ISO tree to ${dest}"
    exit 0
  fi
  echo "no HalfLife2.cab and no hl2/gameinfo.txt inside ${iso}" >&2
  exit 1
fi

if command -v cabextract >/dev/null; then
  cabextract -d "${dest}" "${cab}"
elif command -v 7z >/dev/null; then
  7z x -y -o"${dest}" "${cab}" >/dev/null
else
  echo "need cabextract or 7z to unpack ${cab}" >&2
  exit 1
fi

rm -rf "${work}"
# drop Windows leftovers if the cab put them at the root
find "${dest}" -iname '*.dll' -delete
rm -f "${dest}/hl2/glshaders.cfg"
echo "extracted 2014 GOTY files to ${dest}"
