// REPS — test du repli anglais des packs MUTANT et MIKE, et des fichiers hors pack.
//
//   cd ~/Desktop/reps-app && node docs/test-repli-anglais.mjs
//
// Verifie a quel FICHIER aboutit VP() pour chaque (voix, langue, annonce).
// Pas de son joue : c'est la resolution de chemin qui est testee, la ou etait le bug.
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
const ROOT = path.resolve(process.cwd());   // lancer depuis la racine de reps-app
const srv=http.createServer((q,r)=>{const f=path.join(ROOT,decodeURIComponent(q.url.split('?')[0]));
 if(fs.existsSync(f)&&fs.statSync(f).isFile()){r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});fs.createReadStream(f).pipe(r);}else{r.writeHead(404);r.end('');}});
await new Promise(r=>srv.listen(8090,r));
const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:414,height:896}});
const p=await ctx.newPage();
const err=[]; p.on('pageerror',e=>err.push(e.message));
await p.goto('http://localhost:8090/index.html',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(900);

const cas = [
  // voix, langue, fichier demande, chemin attendu
  ['nina','fr','time-fr.mp3',        'voix/nina/time.mp3'],
  ['nina','fr','rest-fr.mp3',        'voix/nina/rest.mp3'],
  ['nina','fr','round-2-fr.mp3',     'voix/nina/round-2.mp3'],
  ['nina','fr','three-min-fr.mp3',   'voix/nina/three-min.mp3'],
  ['nina','fr','last-minute-fr.mp3', 'voix/nina/last-minute.mp3'],
  ['nina','fr','thirty-sec-fr.mp3',  'voix/nina/thirty-sec.mp3'],
  ['nina','fr','count-fr-3.mp3',     'voix/nina/count-en-3.mp3'],
  ['nina','fr','count-fr-go.mp3',    'voix/nina/count-en-go.mp3'],
  ['nina','fr','fr-1.mp3',           'voix/nina/en-1.mp3'],
  // portugais conserve
  ['nina','pt','time-pt.mp3',        'voix/nina/time-pt.mp3'],
  ['nina','pt','count-pt-3.mp3',     'voix/nina/count-pt-3.mp3'],
  // anglais inchange
  ['nina','en','time.mp3',           'voix/nina/time.mp3'],
  // MUTANT : meme regle, pas de dossier
  ['max','fr','time-fr.mp3',         'time.mp3'],
  ['max','fr','count-fr-5.mp3',      'count-en-5.mp3'],
  ['max','pt','time-pt.mp3',         'time-pt.mp3'],
  // SAM parle francais : rien ne doit bouger
  // 01/09/2026 : les cas EVA sont retires, le pack a ete supprime le 31/08.
  ['sam','fr','time-fr.mp3',         'voix/sam/time-fr.mp3'],
  ['sam','fr','count-fr-3.mp3',      'voix/sam/count-fr-3.mp3'],
  ['sam','fr','round-2-fr.mp3',      'voix/sam/round-2-fr.mp3'],
  // fichiers SANS marqueur de langue : jamais touches, meme en repli
  // tick et beep n'existent qu'a la racine : jamais prefixes, quelle que soit la voix
  ['nina','fr','tick.mp3',           'tick.mp3'],
  ['nina','en','tick.mp3',           'tick.mp3'],
  ['sam','fr','tick.mp3',            'tick.mp3'],
  ['sam','pt','beep.mp3',            'beep.mp3'],
  ['max','fr','beep.mp3',            'beep.mp3'],
  ['max','fr','tick.mp3',            'tick.mp3'],
  // un fichier quelconque reste prefixe : on n'a pas ouvert une breche generale
  ['nina','fr','cartier.mp3',        'voix/nina/cartier.mp3'],
  ['max','fr','cartier.mp3',         'cartier.mp3'],
];
const ok=[],ko=[];
for (const [voix,lang,f,attendu] of cas){
  const got = await p.evaluate(([v,l,file])=>{ S_voix=v; S.lang=l; return VP(file); }, [voix,lang,f]);
  const l = `${voix}/${lang}  ${f}  ->  ${got}`;
  (got===attendu?ok:ko).push(got===attendu?l:l+`   ATTENDU ${attendu}`);
}
// LEO : francais seulement, aucun repli
for (const [voix,lang,f,attendu] of [
  ['leo','fr','time-fr.mp3',   'voix/leo/time-fr.mp3'],
  ['leo','fr','count-fr-3.mp3','voix/leo/count-fr-3.mp3'],
  ['leo','fr','halfway-fr.mp3','voix/leo/halfway-fr.mp3'],
]) {
  const got = await p.evaluate(([v,l,file])=>{ S_voix=v; S.lang=l; return VP(file); }, [voix,lang,f]);
  (got===attendu?ok:ko).push(`${voix}/${lang}  ${f}  ->  ${got}`+(got===attendu?'':`   ATTENDU ${attendu}`));
}
const dispo = await p.evaluate(()=>{
  const o={};
  ['fr','en','pt'].forEach(l=>{ S.lang=l; o[l]={}; ['max','nina','sam','leo'].forEach(v=>{ o[l][v]=voixDisponible(v); }); });
  return o;
});
(dispo.fr.leo===true?ok:ko).push('LEO disponible en francais');
(dispo.en.leo===false?ok:ko).push('LEO indisponible en anglais   ['+dispo.en.leo+']');
(dispo.pt.leo===false?ok:ko).push('LEO indisponible en portugais   ['+dispo.pt.leo+']');
(['max','nina','sam'].every(v=>dispo.fr[v]&&dispo.en[v]&&dispo.pt[v])?ok:ko)
  .push('les trois packs multilingues restent disponibles partout   ['+JSON.stringify(dispo)+']');
// bascule automatique quand la langue rend LEO impossible
const bascule = await p.evaluate(()=>{
  S.lang='fr'; S_voix='sam'; choisirVoix('leo');
  const avant=S_voix;
  S.lang='en'; applyI18n();
  return {avant, apres:S_voix};
});
(bascule.avant==='leo' && bascule.apres==='max' ? ok : ko)
  .push('passage en anglais avec LEO actif -> bascule sur MUTANT   ['+JSON.stringify(bascule)+']');
// le chip LEO est masque hors francais
const chip = await p.evaluate(()=>{
  const b=document.querySelector('.voix-chip[data-voix="leo"]'); if(!b) return 'chip absent';
  S.lang='fr'; majBadgeVoix(); const fr=b.style.display;
  S.lang='en'; majBadgeVoix(); const en=b.style.display;
  S.lang='fr'; majBadgeVoix();
  return {fr, en};
});
(chip && chip.fr==='' && chip.en==='none' ? ok : ko)
  .push('chip LEO visible en francais, masque en anglais   ['+JSON.stringify(chip)+']');

// onsets : MIKE en francais doit utiliser la table EN
const onFR = await p.evaluate(()=>{ S_voix='nina'; S.lang='fr'; return onsetsVoix().join(','); });
const onEN = await p.evaluate(()=>{ S_voix='nina'; S.lang='en'; return onsetsVoix().join(','); });
const onSamFR = await p.evaluate(()=>{ S_voix='sam'; S.lang='fr'; return onsetsVoix().join(','); });
const onSamFRref = await p.evaluate(()=>COUNT_ONSET_VOIX.sam.fr.join(','));
(onFR===onEN?ok:ko).push(`onsets MIKE en francais = table EN  (${onFR})` + (onFR===onEN?'':`   ATTENDU ${onEN}`));
(onSamFR===onSamFRref?ok:ko).push(`onsets SAM en francais = table FR  (${onSamFR})`);

console.log('--- OK ('+ok.length+') ---'); ok.forEach(x=>console.log('  v '+x));
if(ko.length){ console.log('\n--- ECHECS ('+ko.length+') ---'); ko.forEach(x=>console.log('  X '+x)); }
const vraies = err.filter(e=>!/Failed to load|net::ERR|404/i.test(e));
if(vraies.length){ console.log('\n--- ERREURS JS ---'); vraies.forEach(e=>console.log('  ! '+e)); }
console.log('\nBILAN : '+ok.length+' ok, '+ko.length+' ko, '+vraies.length+' erreur(s) JS');
await b.close(); srv.close(); process.exit(ko.length||vraies.length?1:0);
