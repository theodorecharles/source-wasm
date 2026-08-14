# Provenance and source availability

Status: **Still in development**

This repository contains only original wrapper/diagnostic code under MIT. It
does not contain the Source engine, Valve Source SDK code, Half-Life 2 game
code, commercial SDK content, retail game data, or Valve branding.

## Official source boundary

The audit inspected Valve's official
[Source SDK 2013](https://github.com/ValveSoftware/source-sdk-2013) at commit
`22288b919617be6c8ca3cefd7cca979cbb39a88c`. Valve describes that repository as
game code for Half-Life 2, HL2: Deathmatch, and Team Fortress 2, and instructs
users to run it with an installed Source SDK Base 2013. Its
[license](https://github.com/ValveSoftware/source-sdk-2013/blob/master/LICENSE)
applies to that SDK. The repository does not publish the full Source 1 engine
needed to build a standalone browser runtime.

No SDK file is copied, compiled, or distributed here. The inspection checkout
is ignored under `.audit/`, detached at the recorded commit, and has pushing
disabled.

## Rejected reference

The user-authorized `Mxthy/hl2-webxr` reference was inspected at commit
`976342d`. Its documentation identifies its engine basis as a 2020 TF2
leak-fork, and its workflow fetches another repository from that lineage. This
project imports no source, patch, binary, page, or artwork from it.

## Counter-Strike: Source

Counter-Strike: Source is not included. Valve's official Source SDK 2013 does
not provide CS:S game code or the full Source engine. Adding a title selector
or image without an independently distributable engine and game-code basis
would be a false playability claim.

## Required game data

`wasm-game-data.json` records a deliberately small, exact subset from Steam
Half-Life 2 build `19307283`. It exercises `/data` provisioning,
SHA-256 validation, same-origin delivery, and the framework's IndexedDB cache.
Those files are not present in Git, the Docker build context, the public site,
or either image. The administrator supplies them to persistent `/data`.
