// REPS — test du choix de camera (avant / arriere), moitie WEB.
//
//   npm i -g playwright && npx playwright install chromium
//   cd ~/Desktop/reps-app && node docs/test-camera-avant.mjs
//
// Ce que ce test PROUVE : le bouton apparait, memorise le choix, suit la langue,
// refuse la bascule pendant l'enregistrement, et transmet la bonne camera au
// plugin natif. Le plugin est REMPLACE par un faux : rien du Swift n'est teste ici.
// Le miroir de la camera avant ne se verifie que sur un iPhone.
//
// Regle suivie : on clique sur les vrais boutons, on n'appelle pas les fonctions
// a la main. C'est en appelant les fonctions directement qu'on avait rate, le
// 24/08, l'existence d'un second ecran de duree.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.cwd());   // lancer depuis la racine de reps-app
const srv = http.createServer((req,res)=>{
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, {'Content-Type': f.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream'});
    fs.createReadStream(f).pipe(res);
  } else { res.writeHead(404); res.end('nope'); }
});
await new Promise(r=>srv.listen(8080, r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:414,height:896} });

// Faux plugin natif : on ne teste PAS le Swift ici, on teste que le web
// affiche le bouton, memorise le choix et transmet la bonne camera.
await ctx.addInitScript(() => {
  window.__calls = [];
  const VO = {
    ping:        async () => ({value:'pong'}),
    startRecording: async (o) => { window.__calls.push(['start', o]); return {startWallClockMs: Date.now()}; },
    stopRecording:  async () => { window.__calls.push(['stop']); return {path:'/tmp/fake.mov'}; },
    cancelRecording:async () => { window.__calls.push(['cancel']); return {}; },
    exportOverlay:  async () => ({ok:true}),
    pickVideo:      async () => ({}),
  };
  window.Capacitor = { Plugins: { VideoOverlay: VO }, registerPlugin: () => VO, isNativePlatform: () => true, getPlatform: () => 'ios' };
});


// Amene la page a l'ecran chrono, comme un coach au premier lancement :
// choix de la langue, ecran d'accueil qui s'efface, choix du mode.
async function jusquAuChrono(pg){
  // Parcours reel du coach au premier lancement : langue, accueil, mode, duree,
  // musique. On clique sur les vrais boutons, on n'appelle pas les fonctions a la
  // main : c'est comme ca qu'on rate un ecran (cf. etat des lieux du 24/08).
  const ECR=['langChoiceScreen','welcomeScreen','modeChoiceScreen','timingChoiceScreen','musicChoiceScreen','customScreen'];
  const actif = ()=>pg.evaluate(l=>l.find(i=>{const e=document.getElementById(i);if(!e)return false;
    const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&+s.opacity>0.1;})||null, ECR);
  for (let i=0;i<60;i++){
    await pg.waitForTimeout(300);
    const a = await actif();
    if (!a) {                       // un ecran peut etre "invisible" pendant sa transition :
      let net = true;               // on exige trois lectures vides de suite avant de conclure
      for (let k=0;k<3;k++){ await pg.waitForTimeout(250); if (await actif()) { net=false; break; } }
      if (net) return;
      continue;
    }
    if (process.env.TRACE) console.log('   wizard ->', a);
    try {
      if (a==='langChoiceScreen')      await pg.locator('#langChoiceScreen .lang-choice-btn').first().click({force:true,timeout:2000});
      else if (a==='welcomeScreen')    await pg.waitForTimeout(600);
      else if (a==='modeChoiceScreen') await pg.locator('#modeChoiceScreen .mode-tile-amrap').click({force:true,timeout:2000});
      else if (a==='timingChoiceScreen') await pg.locator('#timingChoiceScreen .timing-btn:not(.timing-btn-custom)').nth(1).click({force:true,timeout:2000});
      else if (a==='musicChoiceScreen') {
        // L'ecran musique attend qu'on choisisse un morceau, et les mp3 ne sont pas
        // dans ce serveur de test (seul index.html a ete copie). On sort du wizard
        // par la fonction prevue. C'est le SEUL raccourci du test : tout ce qui
        // concerne la camera est clique pour de vrai, depuis l'ecran chrono.
        if (i > 6) {
          await pg.evaluate(()=>{
            ['modeChoiceScreen','timingChoiceScreen','musicChoiceScreen','customScreen']
              .forEach(id=>{ const e=document.getElementById(id); if(e) e.style.display='none'; });
            if (typeof finishWizard==='function') finishWizard();
          });
          continue;
        }
        // Deux temps : la categorie, puis un morceau.
        const tuile = pg.locator('#musicChoiceScreen .music-tile:visible');
        if (await tuile.count()) { await tuile.first().click({force:true,timeout:2000}); }
        else {
          const piste = pg.locator('#musicChoiceScreen button:not(.wiz-back):visible');
          if (await piste.count()) await piste.first().click({force:true,timeout:2000});
        }
      }
      else {
        const c = pg.locator('#'+a+' button:not(.wiz-back):visible');
        if (await c.count()) await c.first().click({force:true,timeout:2000});
      }
    } catch(e) { /* ecran en transition : on retentera au tour suivant */ }
  }
  throw new Error('ecran chrono non atteint');
}

const page = await ctx.newPage();
const erreurs = [];
page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil:'domcontentloaded' });
await jusquAuChrono(page);
await page.waitForTimeout(1200);           // le show() differe de 800 ms

const ok = [], ko = [];
const T = (nom, cond, detail='') => (cond ? ok : ko).push(nom + (detail?'  ('+detail+')':''));

const btn = page.locator('#btnFilmCam');

// 1. Le bouton apparait, camera arriere par defaut
T('bouton visible', await btn.isVisible());
let txt = (await btn.textContent()).trim();
T('libelle par defaut = arriere', txt === '📷 Arrière', txt);
T('S.filmCam = back', await page.evaluate(()=>S.filmCam) === 'back');

// 2. Un clic : passage en avant, memorise
await btn.click();
txt = (await btn.textContent()).trim();
T('apres clic : libelle avant', txt === '🤳 Avant', txt);
T('apres clic : S.filmCam=front', await page.evaluate(()=>S.filmCam) === 'front');
T('memorise dans localStorage', await page.evaluate(()=>localStorage.getItem('reps_cam')) === 'front');
T('classe .on posee', (await btn.getAttribute('class')).includes('on'));

// 3. La langue : le libelle est ecrit en JS, il doit suivre
await page.evaluate(()=>setLang('en'));
await page.waitForTimeout(150);
txt = (await btn.textContent()).trim();
T('libelle suit la langue (en)', txt === '🤳 Front', txt);
await page.evaluate(()=>setLang('pt'));
await page.waitForTimeout(150);
txt = (await btn.textContent()).trim();
T('libelle suit la langue (pt)', txt === '🤳 Frontal', txt);
await page.evaluate(()=>setLang('fr'));
await page.waitForTimeout(150);

// 4. Le parcours du doigt : on clique VRAIMENT sur Filmer
await page.locator('#btnFilm').click();
await page.waitForTimeout(400);
const calls = await page.evaluate(()=>window.__calls);
const start = calls.find(c=>c[0]==='start');
T('startRecording appele', !!start);
T('camera transmise = front', start && start[1].camera === 'front', start ? JSON.stringify(start[1]) : '');
T('withAudio transmis', start && typeof start[1].withAudio === 'boolean');
T('camHeightPx transmis', start && start[1].camHeightPx > 40, start ? 'camHeightPx='+start[1].camHeightPx : '');

// 5. Pendant l'enregistrement : bascule interdite
T('S.filming vrai', await page.evaluate(()=>!!S.filming));
await page.evaluate(()=>document.getElementById('btnFilmCam').click());
await page.waitForTimeout(100);
T('bascule refusee pendant le tournage', await page.evaluate(()=>S.filmCam) === 'front');

// 6. Persistance apres relance
await page.evaluate(()=>{ try{ toggleFilm(); }catch(e){} });
await page.waitForTimeout(200);
const page2 = await ctx.newPage();
page2.on('pageerror', e => erreurs.push('pageerror(2): ' + e.message));
await page2.goto('http://localhost:8080/index.html', { waitUntil:'domcontentloaded' });
await jusquAuChrono(page2);
await page2.waitForTimeout(1200);
txt = (await page2.locator('#btnFilmCam').textContent()).trim();
T('choix retrouve au relancement', txt === '🤳 Avant', txt);

// 7. Retour arriere
await page2.locator('#btnFilmCam').click();
txt = (await page2.locator('#btnFilmCam').textContent()).trim();
T('retour en arriere', txt === '📷 Arrière', txt);
await page2.locator('#btnFilm').click();
await page2.waitForTimeout(400);
const c2 = await page2.evaluate(()=>window.__calls.find(c=>c[0]==='start'));
T('camera transmise = back', c2 && c2[1].camera === 'back', c2?JSON.stringify(c2[1]):'');

console.log('\n--- REUSSIS ('+ok.length+') ---');
ok.forEach(x=>console.log('  v ' + x));
if (ko.length){ console.log('\n--- ECHECS ('+ko.length+') ---'); ko.forEach(x=>console.log('  X ' + x)); }
const vraiesErreurs = erreurs.filter(e=>!/Failed to load|net::ERR|404/i.test(e));
if (vraiesErreurs.length){ console.log('\n--- ERREURS JS ---'); vraiesErreurs.forEach(e=>console.log('  ! '+e)); }
console.log('\nBILAN : ' + ok.length + ' ok, ' + ko.length + ' ko, ' + vraiesErreurs.length + ' erreur(s) JS');

await browser.close(); srv.close();
process.exit(ko.length || vraiesErreurs.length ? 1 : 0);
