// REPS — test de l'annonce de mi-parcours (25/08/2026).
//
//   cd ~/Desktop/reps-app && node docs/test-mi-parcours.mjs
//
// checkAnnounce() est appele avec un etat force, et on observe ce qui part.
// annonceVoix et showAnnounce sont remplaces par des mouchards : on teste la
// DECISION (quand ca sonne, quoi, une seule fois), pas la restitution audio.
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
const ROOT = path.resolve(process.cwd());   // lancer depuis la racine de reps-app
const srv=http.createServer((q,r)=>{const f=path.join(ROOT,decodeURIComponent(q.url.split('?')[0]));
 if(fs.existsSync(f)&&fs.statSync(f).isFile()){r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});fs.createReadStream(f).pipe(r);}else{r.writeHead(404);r.end('');}});
await new Promise(r=>srv.listen(8095,r));
const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:414,height:896}});
const p=await ctx.newPage();
const err=[]; p.on('pageerror',e=>err.push(e.message));
await p.goto('http://localhost:8095/index.html',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(900);

await p.evaluate(()=>{
  window.__vu=[];
  window.annonceVoix=(cle)=>window.__vu.push({voix:cle});
  window.showAnnounce=(t)=>window.__vu.push({ecran:t});
  window.speak=()=>window.__vu.push({speak:true});
  window.playCount=()=>{}; window.playBipDecompte=()=>{}; window.playTick=()=>{};
});

// Rejoue un WOD seconde par seconde et renvoie ce qui est sorti, par seconde restante
async function derouler(mode,total,lang,de,a){
  return await p.evaluate(([mode,total,lang,de,a])=>{
    S.mode=mode; S.total=total; S.lang=lang; S.miDit=false; S.state='playing';
    const sorties=[];
    for(let r=de;r>=a;r--){
      S.remain=r; window.__vu=[];
      try{ checkAnnounce(); }catch(e){ sorties.push([r,'ERREUR '+e.message]); continue; }
      if(window.__vu.length) sorties.push([r, JSON.stringify(window.__vu)]);
    }
    return sorties;
  },[mode,total,lang,de,a]);
}

const ok=[],ko=[];
const T=(nom,cond,detail='')=>(cond?ok:ko).push(nom+(detail?'   ['+detail+']':''));
const mi = l => l.filter(x=>/MOITI/.test(x[1]));

// 1. For Time 10 min : une seule fois, a 5:00 restantes
let d = await derouler('wod',600,'fr',600,1);
let m = mi(d);
T('For Time 10 min : une seule annonce', m.length===1, JSON.stringify(m));
T('For Time 10 min : a 300 s restantes', m[0] && m[0][0]===300, m[0]?String(m[0][0]):'aucune');
T('For Time 10 min : les 3 min et la derniere min sortent toujours',
  d.some(x=>x[0]===180) && d.some(x=>x[0]===60));

// 2. For Time 5 min : la moitie tombe a 2:30
d = await derouler('wod',300,'fr',300,1); m = mi(d);
T('For Time 5 min : annonce a 150 s', m.length===1 && m[0][0]===150, JSON.stringify(m));

// 3. Duree impaire : 7 min 30 -> 225 s
d = await derouler('wod',450,'fr',450,1); m = mi(d);
T('For Time 7:30 : annonce a 225 s', m.length===1 && m[0][0]===225, JSON.stringify(m));

// 4. AMRAP 12 min : collision avec le repere des 6 minutes, la moitie gagne
d = await derouler('amrap',720,'fr',720,1); m = mi(d);
const a360 = d.filter(x=>x[0]===360);
T('AMRAP 12 : annonce a 360 s', m.length===1 && m[0][0]===360, JSON.stringify(m));
T('AMRAP 12 : le repere min6 ne sort PAS en meme temps',
  a360.length===1 && !/min6/.test(a360[0][1]), a360.length?a360[0][1]:'rien');
T('AMRAP 12 : les autres reperes sont intacts (9, 3, 2, 1 min, 30 s)',
  [540,180,120,60,30].every(r=>d.some(x=>x[0]===r)));

// 5. AMRAP 20 min : pas de collision, 10:00 n'est pas un repere
d = await derouler('amrap',1200,'fr',1200,1); m = mi(d);
T('AMRAP 20 : annonce a 600 s', m.length===1 && m[0][0]===600, JSON.stringify(m));

// 6. Langues : rien en anglais ni en portugais
for (const L of ['en','pt']) {
  d = await derouler('wod',600,L,600,1);
  T('For Time en '+L+' : aucune annonce de mi-parcours', mi(d).length===0, JSON.stringify(mi(d)));
}

// 7. Modes exclus
for (const mode of ['emom','tabata']) {
  d = await derouler(mode,600,'fr',600,1);
  T(mode+' : aucune annonce de mi-parcours', mi(d).length===0, JSON.stringify(mi(d)));
}

// 8. Le decompte final prime : WOD de 20 s, la moitie vaut 10 s
d = await derouler('wod',20,'fr',20,1); m = mi(d);
T('WOD 20 s : le decompte des 10 s prime, pas de mi-parcours', m.length===0, JSON.stringify(m));

// 9. Pas de repetition si la meme seconde est reevaluee
const rep = await p.evaluate(()=>{
  S.mode='wod'; S.total=600; S.lang='fr'; S.miDit=false; S.state='playing'; S.remain=300;
  let n=0;
  for(let i=0;i<5;i++){ window.__vu=[]; checkAnnounce(); if(JSON.stringify(window.__vu).match(/MOITI/)) n++; }
  return n;
});
T('seconde rejouee 5 fois : une seule annonce', rep===1, 'sorties='+rep);

// 10. resetTimer remet le drapeau
const apresReset = await p.evaluate(()=>{ S.miDit=true; try{ resetTimer(); }catch(e){} return S.miDit; });
T('resetTimer reactive l\'annonce pour le WOD suivant', apresReset===false, 'S.miDit='+apresReset);

// 11. La cle de fichier existe en francais et pas ailleurs
const cles = await p.evaluate(()=>({fr:VOICE_FILES.fr.half, en:VOICE_FILES.en.half, pt:VOICE_FILES.pt.half, present:VOICE_FILES_PRESENTS.half}));
T('fichier francais mappe', cles.fr==='halfway-fr.mp3', JSON.stringify(cles));
T('rien en anglais ni en portugais', !cles.en && !cles.pt);
T('marque comme present', cles.present===true);

// 12. Le repli anglais tient toujours pour les packs anglophones
// 01/09/2026 : EVA retiree du selecteur ET de VOIX_PACKS le 31/08. Son cas est
// supprime ici, il testait un pack qui n'existe plus (VP() ne le prefixe donc plus).
const replis = await p.evaluate(()=>{ const o={}; ['max','nina','sam','leo'].forEach(v=>{ S_voix=v; S.lang='fr'; o[v]=VP('halfway-fr.mp3'); }); return o; });
T('MUTANT en francais -> halfway anglais', replis.max==='halfway.mp3', replis.max);
T('MIKE en francais -> halfway anglais', replis.nina==='voix/nina/halfway.mp3', replis.nina);
T('SAM garde le francais', replis.sam==='voix/sam/halfway-fr.mp3', replis.sam);
T('LEO garde le francais', replis.leo==='voix/leo/halfway-fr.mp3', replis.leo);

console.log('--- OK ('+ok.length+') ---'); ok.forEach(x=>console.log('  v '+x));
if(ko.length){ console.log('\n--- ECHECS ('+ko.length+') ---'); ko.forEach(x=>console.log('  X '+x)); }
const vraies = err.filter(e=>!/Failed to load|net::ERR|404/i.test(e));
if(vraies.length){ console.log('\n--- ERREURS JS ---'); vraies.forEach(e=>console.log('  ! '+e)); }
console.log('\nBILAN : '+ok.length+' ok, '+ko.length+' ko, '+vraies.length+' erreur(s) JS');
await b.close(); srv.close(); process.exit(ko.length||vraies.length?1:0);
