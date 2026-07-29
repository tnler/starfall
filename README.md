# STARFALL

An open-world co-op FPS in the shape of Destiny. One continuous world — no
loading screens between anything. 3600 units across, built around **the
Descent**: a shaft bored 780 units toward the core, ringed by eight terraces of
city and wrapped in a skyline you can see from the far side of the map. A
spiral road runs the whole way down it.

Patrol the flats, walk into the dungeon, climb the raid spire. Three classes,
live loot, and up to 8 guardians per shard.

Runs in the browser. No install, no build step, no accounts.

## Play

```
npm start          # -> http://localhost:7722
```

Send a friend the same URL and you are in the same shard automatically. The
first player in becomes the host and simulates the world; everyone else mirrors
it. If the socket never opens the game runs solo, unchanged.

**Deep links** — skip the menu and drop straight in:

```
/?drop=phantom              pick a class and start
/?class=oracle&name=Tyler   prefill the menu, still press DROP IN
/?drop=warden&server=       start solo, no shard
/?at=520,80                 drop in at any x,z on the surface
```

## Controls

| | |
|---|---|
| WASD / Shift / Ctrl | move · sprint · slide |
| Space | jump (class jump in air: lift, glide, double) |
| LMB / RMB | fire · aim |
| R · Q · V · E · X | reload · grenade · melee · class ability · super |
| C | movement ability (Thrusters / Blink / Slipstream) |
| F · Tab · M · Enter | interact · inventory · map · chat |

## The loop

- **Rank** rises with XP from everything you do, to a cap of 50. Every rank
  raises the *power floor* the world rolls drops at, so playing at all keeps
  your gear climbing. Twelve milestone perks cut ability cooldowns and raise
  shields — the ladder is in the character screen (Tab).
- **Power** is the average of your equipped gear. Fighting above your power
  costs damage; it never locks you out.
- **Loot** rolls rarity, stats and perks per source. Dungeon and raid bosses
  roll higher and can guarantee exotics.
- **Blades** — knife, sword, axe and scythe take your kinetic slot. You give up
  a primary weapon and get up to +26% movement speed for it, plus no ammo to
  manage. A knife is in your bag from the first minute.
- **Rocket jumping** — your own explosives throw you. Fire at your feet and you
  go up; it costs a little health, and enemy rockets never move you.
- **Movement abilities** — every class has one on a 3–4s cooldown, separate
  from the class ability, and all three work in mid-air: the Warden gets a
  thruster leap, the Oracle a blink that goes through gaps, the Phantom a long
  air dash that refreshes the double jump.

## Content

- **The Descent** — the shaft at the centre of the world. Eight ring terraces
  of towers hang off a spiral viaduct that is walkable from the rim to the
  floor, lit the whole way down. You spawn on a pier cantilevered over it.
- **The Sundered Shore** — eight regions, ambient patrols, a public event on a
  world timer, and a lost sector you walk into. Nineteen enemy types: rushers
  that detonate, stalkers that blink to you, hovering sentinels, long-range
  lancers, ravagers that knock you off ledges, and seraphs that hunt with
  homing fire.
- **The Hollow Choir** — a three-encounter dungeon under the shore.
- **Spire of the Sundered Sky** — a three-encounter raid you climb.

## Tests

There is no framework. Two headless harnesses import the real modules and play
the game without a screen:

```
npm test           # probe (world, combat, every weapon, every encounter) + UI check
npm run netcheck   # two guardians on one shard — needs a server running
node tools/perfcheck.mjs   # build time, draw calls, triangles, streaming cost
```

The probe builds the world, benches all 11 weapon archetypes against a live
target, casts every ability of every class, runs each dungeon and raid
encounter, then soaks 2400 frames checking for leaks. `netcheck` talks the real
wire protocol to a running server and covers the handshake, host election,
position and chat relay, and the host handover when the host disconnects.

## Deploy

`render.yaml` is a Render blueprint: connect the repo and it serves the static
files and the WebSocket shard on the same port. Any host that runs
`node serve.js` and passes `PORT` works — the server has zero dependencies.
