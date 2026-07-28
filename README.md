# STARFALL

An open-world co-op FPS in the shape of Destiny. One continuous world — no
loading screens between anything. Patrol the shore, walk into the dungeon,
climb the raid spire. Three classes, live loot, and up to 8 guardians per shard.

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
```

## Controls

| | |
|---|---|
| WASD / Shift / Ctrl | move · sprint · slide |
| Space | jump (class jump in air: lift, glide, double) |
| LMB / RMB | fire · aim |
| R · Q · V · E · X | reload · grenade · melee · class ability · super |
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

## Content

- **The Sundered Shore** — six regions, ambient patrols, a public event on a
  world timer, and a lost sector you walk into.
- **The Hollow Choir** — a three-encounter dungeon under the shore.
- **Spire of the Sundered Sky** — a three-encounter raid you climb.

## Tests

There is no framework. Two headless harnesses import the real modules and play
the game without a screen:

```
npm test           # probe (world, combat, every weapon, every encounter) + UI check
```

The probe builds the world, benches all 11 weapon archetypes against a live
target, casts every ability of every class, runs each dungeon and raid
encounter, then soaks 2400 frames checking for leaks.

## Deploy

`render.yaml` is a Render blueprint: connect the repo and it serves the static
files and the WebSocket shard on the same port. Any host that runs
`node serve.js` and passes `PORT` works — the server has zero dependencies.
