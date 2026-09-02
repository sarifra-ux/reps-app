// REPS — test du signal de depart et du nouveau tick, moitie WEB.
//
//   npm i -g playwright && npx playwright install chromium
//   cd ~/Desktop/reps-app && node docs/test-signal-depart.mjs
//   cd ~/Desktop/reps-app && VARIANTE=2 node docs/test-signal-depart.mjs
//
// Execute le 26/08/2026 : 22 verifications vertes dans CHAQUE variante, zero
// erreur JS. Lance depuis un environnement ou seuls index.html et les mp3 du
// decompte anglais etaient presents ; ici, lance a la racine du depot, tout y est.
//
// Ce que ce test PROUVE : au lancement d'un WOD, les sons reellement joues sont
// ceux attendus, aux bons instants, et le signal de depart n'est JAMAIS prefixe
// par le dossier du pack de voix (le 404 silencieux qui a tue le bip).
//
// Regle suivie : on clique sur le vrai bouton de lancement. On n'appelle pas
// launch() a la main.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.cwd());   // lancer depuis la racine de reps-app
const VARIANTE = process.env.VARIANTE === '2' ? 2 : 1;

// Variante 2 : on sert une copie ou la constante est a false. On ne modifie pas
// le fichier de travail.
if (VARIANTE === 2) {
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const out = src.replace('const SIGNAL_DEPART_REMPLACE_VOIX=true;',
                          'const SIGNAL_DEPART_REMPLACE_VOIX=false;');
  if (out === src) { console.error('KO: constante introuvable pour la variante 2'); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, 'index-v2.html'), out);   // copie jetable, a la racine
}
const PAGE = VARIANTE === 2 ? 'index-v2.html' : 'index.html';

const srv = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'audio/mpeg' });
    fs.createReadStream(f).pipe(res);
  } else { res.writeHead(404); res.end('nope'); }
});
await new Promise(r => srv.listen(8080, r));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });

// Mouchard : on enregistre CHAQUE appel a play() avec la source reellement
// demandee. C'est le src apres VP(), donc un prefixe de pack parasite se verrait.
await ctx.addInitScript(() => {
  window.__sons = [];
  window.__t0 = null;
  const vrai = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try {
      const s = (this.src || '').split('/').slice(3).join('/');
      if (s.endsWith('.mp3')) window.__sons.push({ f: s, t: Date.now() });
    } catch (e) {}
    try { return vrai.apply(this, arguments); } catch (e) { return Promise.resolve(); }
  };
});

async function jusquAuChrono(pg) {
  const ECR = ['langChoiceScreen','welcomeScreen','modeChoiceScreen','timingChoiceScreen','musicChoiceScreen','customScreen'];
  const actif = () => pg.evaluate(l => l.find(i => { const e = document.getElementById(i); if (!e) return false;
    const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.1; }) || null, ECR);
  for (let i = 0; i < 60; i++) {
    await pg.waitForTimeout(300);
    const a = await actif();
    if (!a) { let net = true;
      for (let k = 0; k < 3; k++) { await pg.waitForTimeout(250); if (await actif()) { net = false; break; } }
      if (net) return; continue; }
    try {
      if (a === 'langChoiceScreen')        await pg.locator('#langChoiceScreen .lang-choice-btn').nth(1).click({ force: true, timeout: 2000 });
      else if (a === 'welcomeScreen')      await pg.waitForTimeout(600);
      else if (a === 'modeChoiceScreen')   await pg.locator('#modeChoiceScreen .mode-tile-amrap').click({ force: true, timeout: 2000 });
      else if (a === 'timingChoiceScreen') await pg.locator('#timingChoiceScreen .timing-btn:not(.timing-btn-custom)').nth(1).click({ force: true, timeout: 2000 });
      else if (a === 'musicChoiceScreen') {
        // Les morceaux de musique ne sont pas dans ce serveur de test. On sort du
        // wizard par la fonction prevue : c'est le SEUL raccourci. Le lancement du
        // WOD, lui, est un vrai clic sur le vrai bouton.
        if (i > 6) { await pg.evaluate(() => {
            ['modeChoiceScreen','timingChoiceScreen','musicChoiceScreen','customScreen']
              .forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; });
            if (typeof finishWizard === 'function') finishWizard(); });
          continue; }
        const t = pg.locator('#musicChoiceScreen .music-tile:visible');
        if (await t.count()) await t.first().click({ force: true, timeout: 2000 });
        else { const p = pg.locator('#musicChoiceScreen button:not(.wiz-back):visible');
               if (await p.count()) await p.first().click({ force: true, timeout: 2000 }); }
      } else { const c = pg.locator('#' + a + ' button:not(.wiz-back):visible');
               if (await c.count()) await c.first().click({ force: true, timeout: 2000 }); }
    } catch (e) {}
  }
  throw new Error('ecran chrono non atteint');
}

const page = await ctx.newPage();
const erreurs = [];
page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));
await page.goto(`http://localhost:8080/${PAGE}`, { waitUntil: 'domcontentloaded' });
await jusquAuChrono(page);
await page.waitForTimeout(1200);

if (process.env.DIAG) {
  console.log('URL   :', page.url());
  console.log('ERRS  :', JSON.stringify(erreurs));
  console.log('probe :', JSON.stringify(await page.evaluate(() => ({
    vp: typeof VP, packs: typeof VOIX_PACKS, liste: typeof listeDecompte,
    start: typeof START_AUDIO, S: typeof S,
    html: document.body ? document.body.innerHTML.slice(0,200) : -1, head: document.head ? document.head.innerHTML.length : -1, scripts: document.scripts.length,
  })).catch(e => ({ err: String(e).slice(0, 200) }))));
}

const ok = [], ko = [];
const T = (nom, cond, detail = '') => (cond ? ok : ko).push(nom + (detail ? '  (' + detail + ')' : ''));

// ---------- 1. resolution des chemins : le piege du 404 silencieux ----------
const vp = await page.evaluate(() => {
  const r = {};
  for (const cle of Object.keys(VOIX_PACKS)) { S_voix = cle; r[cle] = VP(START_AUDIO) + '|' + VP(TICK_AUDIO); }
  S_voix = 'max';
  return r;
});
for (const [cle, v] of Object.entries(vp))
  T(`VP() laisse le signal et le tick a la racine avec ${cle}`, v === 'start-signal.mp3|tick.mp3', v);

// ---------- 2. la liste du decompte ----------
const info = await page.evaluate(() => ({
  remplace: SIGNAL_DEPART_REMPLACE_VOIX,
  liste: listeDecompte(),
  onsets: onsetsDecompte(),
  onsetsVoix: onsetsVoix(),
  lang: S.lang,
}));
T('langue de test = en', info.lang === 'en', info.lang);
T('la liste du decompte fait 11 entrees', info.liste.length === 11, String(info.liste.length));
if (VARIANTE === 1) {
  T('index 10 = signal de depart', info.liste[10] === 'start-signal.mp3', info.liste[10]);
  T('la voix du GO ne figure plus dans la liste', !info.liste.includes('count-en-go.mp3'));
  T('onset du signal force a 0', info.onsets[10] === 0, String(info.onsets[10]));
} else {
  T('index 10 = voix du GO', info.liste[10] === 'count-en-go.mp3', info.liste[10]);
  T('onsets inchanges', JSON.stringify(info.onsets) === JSON.stringify(info.onsetsVoix));
}
T('les 10 premiers restent la voix', info.liste.slice(0, 10).every(f => f.startsWith('count-en-')));

// ---------- 3. prechargement natif ----------
const pre = await page.evaluate(() => (typeof _naFiles === 'function' ? _naFiles() : null));
if (pre) T('le signal est dans la liste de prechargement natif', pre.includes('start-signal.mp3'));

// ---------- 4. LE VRAI TEST : on lance un WOD et on ecoute ----------
await page.evaluate(() => { window.__sons = []; window.__t0 = Date.now(); });
await page.locator('#btnPlay').click({ force: true, timeout: 3000 });
await page.waitForTimeout(12500);

const sons = await page.evaluate(() => ({ s: window.__sons, t0: window.__t0 }));
const seq = sons.s.map(x => ({ f: x.f, t: Math.round((x.t - sons.t0) / 100) / 10 }));
const noms = seq.map(x => x.f);

T('des sons ont bien ete joues', seq.length > 0, String(seq.length));
// Le premier son de la page est la musique, pas le decompte : on filtre.
const cd = seq.filter(x => x.f.startsWith('count-') && x.f !== 'count-en-go.mp3');
T('le decompte part sur count-en-10', cd.length > 0 && cd[0].f === 'count-en-10.mp3', (cd[0]||{}).f || '-');
T('les 10 chiffres sonnent, 10 puis 9 ... jusqu a 1', cd.length === 10, String(cd.length));

// LE TICK NE SONNE PAS ICI, ET C'EST NORMAL.
// playBipDecompte() est appele depuis checkAnnounce() sur les 3 DERNIERES secondes
// du WOD, et sur les 3 dernieres de chaque intervalle EMOM. Le decompte de DEPART,
// lui, ne joue que la voix. Constate a l'execution le 26/08/2026 : zero tick sur
// les 12 premieres secondes d'un AMRAP.
// Ce test ne couvre donc PAS le declenchement du tick. Il n'a pas change : le
// correctif du 26/08 remplace le FICHIER tick.mp3, pas une ligne de code autour.
const ticks = seq.filter(x => x.f === 'tick.mp3');
T('aucun tick sur le decompte de depart (comportement attendu)', ticks.length === 0,
  ticks.map(x => x.t + 's').join(' '));

const sig = seq.filter(x => x.f === 'start-signal.mp3');
T('le signal de depart sonne une fois', sig.length === 1, String(sig.length));

const go = seq.filter(x => x.f === 'count-en-go.mp3');
if (VARIANTE === 1) T('la voix du GO ne sonne pas', go.length === 0, String(go.length));
else                T('la voix du GO sonne aussi', go.length === 1, String(go.length));

if (sig.length === 1) {
  const dernier = cd.length ? cd[cd.length - 1] : null;
  T('le signal tombe apres le « un »',
    dernier !== null && sig[0].t > dernier.t, `${(dernier||{}).f} ${(dernier||{}).t}s -> signal ${sig[0].t}s`);
  T('une seconde pleine entre le « un » et le signal',
    dernier !== null && Math.abs((sig[0].t - dernier.t) - 1) < 0.25, `${Math.round((sig[0].t-(dernier||{}).t)*100)/100}s`);
  T('le signal tombe autour de 10 s apres le lancement', Math.abs(sig[0].t - 10) < 1.5, sig[0].t + 's');
  if (VARIANTE === 2 && go.length === 1)
    T('signal et voix du GO au meme instant', Math.abs(sig[0].t - go[0].t) < 0.15,
      `signal ${sig[0].t}s / voix ${go[0].t}s`);
}
T('aucun 404 sur un fichier prefixe par un pack', !noms.some(f => f.startsWith('voix/')),
  noms.filter(f => f.startsWith('voix/')).join(' '));
T('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));

console.log(`\n=== SIGNAL DE DEPART — variante ${VARIANTE} (${VARIANTE === 1 ? 'le signal remplace la voix du GO' : 'signal EN PLUS de la voix'}) ===`);
console.log('sequence entendue :');
for (const x of seq) console.log(`   ${String(x.t).padStart(5)}s  ${x.f}`);
console.log('');
ok.forEach(t => console.log('  OK  ' + t));
ko.forEach(t => console.log('  KO  ' + t));
console.log(`\n${ok.length} verifications vertes, ${ko.length} rouges\n`);

await browser.close();
srv.close();
process.exit(ko.length ? 1 : 0);
