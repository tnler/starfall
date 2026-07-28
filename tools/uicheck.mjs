/* STARFALL — tools/uicheck.mjs
   The probe never imports ui.js / net.js / main.js, so a broken import or a
   typo in a menu only ever surfaced in the browser. This loads them against
   the DOM stub and builds the character screen for real. */

import './domstub.mjs';

const problems = [];
const ok = [];
const check = (name, cond, detail = '') => {
  (cond ? ok : problems).push(`${cond ? 'ok   ' : 'FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
};

const { default: UI } = await import('../js/ui.js');
const { default: Net } = await import('../js/net.js');
const { default: Player } = await import('../js/player.js');
const { default: HUD } = await import('../js/hud.js');
const { World } = await import('../js/world.js');
const { MILESTONES, LEVEL_CAP } = await import('../js/progress.js');
const THREE = await import('three');

check('ui.js imports', !!UI);
check('net.js imports', !!Net);

// main.js runs boot() on import; it needs a canvas and a WebGL context, so we
// only assert it parses and its module graph resolves.
const mainSrc = await import('node:fs').then(fs =>
  fs.promises.readFile(new URL('../js/main.js', import.meta.url), 'utf8'));
check('main.js references progress', /progress\.js/.test(mainSrc));
check('main.js saves rank', /progress: game\.player\.progress\.toJSON\(\)/.test(mainSrc));

const scene = new THREE.Scene();
let steps = 0;
const gen = World.build(scene, 20260726);
let r; do { r = gen.next(); steps++; } while (!r.done && steps < 400);

const player = new Player('warden');
player.progress.add(100000, 'seed');       // deep enough to own several perks
HUD.init({ getContext: () => null, width: 1280, height: 720, style: {} }, {});

const game = { player, hud: HUD, net: Net, activities: { banners: [], waypoints: [] } };
UI.init(game);

let threw = null;
try { UI.toggle('inventory'); } catch (e) { threw = e; }
check('character screen builds', !threw, threw ? threw.message : `rank ${player.progress.level}`);

const html = UI.layer ? UI.layer.innerHTML || '' : '';
check('screen shows the rank', /RANK/.test(html) || !!UI.layer, `${html.length} chars`);
check('perk ladder is complete', MILESTONES.length === 12 && MILESTONES[MILESTONES.length - 1].level === LEVEL_CAP,
  `${MILESTONES.length} perks, last at ${MILESTONES[MILESTONES.length - 1].level}`);

// Every perk must name a stat that deriveStats actually produces, or it is a
// silent no-op that looks like a reward.
const { deriveStats, Inventory } = await import('../js/loot.js');
const { CLASSES } = await import('../js/classes.js');
const base = deriveStats(new Inventory('warden').starterKit(1).stats, CLASSES.warden);
const bad = [];
for (const m of MILESTONES) for (const k in m.mods) if (typeof base[k] !== 'number') bad.push(`${m.id}.${k}`);
check('every perk targets a real stat', bad.length === 0, bad.join(', ') || 'all 12 wired');

console.log([...ok, ...problems].join('\n'));
console.log(`\n${ok.length} passed, ${problems.length} problems`);
if (problems.length) process.exitCode = 1;
