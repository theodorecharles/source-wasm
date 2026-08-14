# Source inventory

Status: **Still in development**

The compiled checkpoint is the original MIT-licensed adapter and diagnostic
module in this repository. The entries below record the source review that
defines the current engine boundary.

## Valve Source SDK 2013

The audit inspected Valve's official
[Source SDK 2013](https://github.com/ValveSoftware/source-sdk-2013) at commit
`22288b919617be6c8ca3cefd7cca979cbb39a88c`. Valve describes that repository as
game code for Half-Life 2, HL2: Deathmatch, and Team Fortress 2, and instructs
users to run it with an installed Source SDK Base 2013. Its
[license](https://github.com/ValveSoftware/source-sdk-2013/blob/master/LICENSE)
applies to that SDK. The repository does not publish the full Source 1 engine
needed to build a standalone browser runtime.

The inspection checkout is ignored under `.audit/`, detached at the recorded
commit, and is not a build input.

## Excluded reference

The user-authorized `Mxthy/hl2-webxr` reference was inspected at commit
`976342d`. Its documentation identifies its engine basis as a 2020 TF2
leak-fork, and its workflow fetches another repository from that lineage. It is
recorded for comparison and is not a build input.

## Counter-Strike: Source

Counter-Strike: Source is not included. Valve's official Source SDK 2013 does
not provide CS:S game code or the full Source engine.

## Required game data

`wasm-game-data.json` records a deliberately small, exact subset from Steam
Half-Life 2 build `19307283`. It exercises `/data` provisioning,
SHA-256 validation, same-origin delivery, and the framework's IndexedDB cache.
The container stores the required files in persistent `/data`.
