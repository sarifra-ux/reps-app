// TEST — encouragements aleatoires pendant un WOD (31/08/2026)
//
// Ce que ce test prouve :
//   1. eteint (ENCOURAGEMENTS_ACTIFS=false), le systeme ne planifie ni ne joue RIEN ;
//   2. allume, aucun encouragement ne tombe a moins de 10 s d'un repere existant ;
//   3. rien dans la derniere minute, rien dans les 20 premieres secondes ;
//   4. le sac de tirage ne rejoue pas une phrase tant qu'il en reste une non jouee ;
//   5. EMOM et Tabata ne planifient rien.
//
// Les invariants sont verifies sur 500 tirages, parce que le planning est aleatoire :
// un seul passage ne prouve rien sur une fonction qui appelle Math.random.
//
//   node docs/test-encouragements.mjs
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extraire(nom){
  const debut = html.indexOf('function ' + nom + '(');
  if (debut < 0) throw new Error('fonction introuvable : ' + nom);
  let prof = 0;
  for (let j = html.indexOf('{', debut); j < html.length; j++){
    if (html[j] === '{') prof++;
    else if (html[j] === '}' && --prof === 0) return html.slice(debut, j + 1);
  }
  throw new Error('accolade non fermee : ' + nom);
}
function constante(nom){
  const m = new RegExp('const ' + nom + '\\s*=\\s*([^;]+);').exec(html);
  if (!m) throw new Error('constante introuvable : ' + nom);
  return m[1].trim();
}

// L'etat reel du fichier, pour le test 1.
const ACTIFS_DANS_LE_FICHIER = constante('ENCOURAGEMENTS_ACTIFS') === 'true';

function construire(actifs){
  const src = `
const ENCOURAGEMENTS_ACTIFS = ${actifs};
const ENCOURAGEMENTS_INTERVALLE = ${constante('ENCOURAGEMENTS_INTERVALLE')};
const ENCOURAGEMENT_GARDE = ${constante('ENCOURAGEMENT_GARDE')};
const ENCOURAGEMENT_FIN = ${constante('ENCOURAGEMENT_FIN')};
const ENCOURAGEMENT_DEBUT = ${constante('ENCOURAGEMENT_DEBUT')};
const ENCOURAGEMENT_FENETRE_FINALE = ${constante('ENCOURAGEMENT_FENETRE_FINALE')};
const ENCOURAGEMENTS_GENERAL = ${constante('ENCOURAGEMENTS_GENERAL')};
const ENCOURAGEMENTS_FINALE = ${constante('ENCOURAGEMENTS_FINALE')};
const ENCOURAGEMENTS_PACKS = ${constante('ENCOURAGEMENTS_PACKS')};
let S_voix = 'sam';
let _encPlanning=[], _encSacGeneral=[], _encSacFinale=[];
${extraire('encReperesOccupes')}
${extraire('encSecondeLibre')}
${extraire('planifierEncouragements')}
${extraire('tirerEncouragement')}
export const api={planifierEncouragements,tirerEncouragement,encReperesOccupes,
  get planning(){return _encPlanning.slice();},
  set pack(v){S_voix=v;}};`;
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
}

const off = (await construire(false)).api;
const on  = (await construire(true)).api;

let echecs = 0, tests = 0;
function verifie(nom, cond, detail){
  tests++;
  if (cond) console.log('  ok   ' + nom);
  else { echecs++; console.log('  ECHEC ' + nom + (detail ? '  -> ' + detail : '')); }
}

console.log('\n=== 1. L\'INTERRUPTEUR ET LES GARDES ===');
verifie('le systeme est ALLUME dans le fichier (les 8 mp3 sont poses)', ACTIFS_DANS_LE_FICHIER,
        'ENCOURAGEMENTS_ACTIFS = ' + ACTIFS_DANS_LE_FICHIER);
on.pack = 'max';
verifie('pack MUTANT : rien planifie (il n\'a pas les fichiers)',
        on.planifierEncouragements(720, 'amrap', 'fr').length === 0);
on.pack = 'nina';
verifie('pack MIKE : rien planifie', on.planifierEncouragements(720, 'amrap', 'fr').length === 0);
on.pack = 'sam';
verifie('pack SAM : ca planifie', on.planifierEncouragements(720, 'amrap', 'fr').length > 0);
on.pack = 'leo';
verifie('pack LEO : ca planifie', on.planifierEncouragements(720, 'amrap', 'fr').length > 0);
on.pack = 'sam';
verifie('app en anglais : rien planifie (phrases francaises seulement)',
        on.planifierEncouragements(720, 'amrap', 'en').length === 0);
verifie('app en portugais : rien planifie',
        on.planifierEncouragements(720, 'amrap', 'pt').length === 0);
verifie('interrupteur a false : plus rien n\'est planifie',
        off.planifierEncouragements(720, 'amrap', 'fr').length === 0);
verifie('interrupteur a false, WOD 30 min : idem',
        off.planifierEncouragements(1800, 'wod', 'fr').length === 0);

console.log('\n=== 2. ALLUME : jamais de collision avec un repere (500 tirages) ===');
const CAS = [
  { total: 720,  mode: 'amrap', nom: 'AMRAP 12 min' },
  { total: 1200, mode: 'amrap', nom: 'AMRAP 20 min' },
  { total: 1800, mode: 'amrap', nom: 'AMRAP 30 min' },
  { total: 900,  mode: 'wod',   nom: 'WOD 15 min'   },
];
for (const c of CAS){
  let collisions = 0, tropTard = 0, tropTot = 0, vides = 0, tailles = new Set();
  const occ = on.encReperesOccupes(c.total, c.mode, 'fr');
  for (let i = 0; i < 500; i++){
    const plan = on.planifierEncouragements(c.total, c.mode, 'fr').map(e=>e.r);
    if (!plan.length) vides++;
    tailles.add(plan.length);
    for (const r of plan){
      if (occ.some(o => Math.abs(r - o) <= 10)) collisions++;
      if (r <= 60) tropTard++;
      if (r > c.total - 20) tropTot++;
    }
  }
  console.log(`  ${c.nom} : ${[...tailles].join('/')} encouragement(s) par wod`);
  verifie(c.nom + ' — zero collision avec un repere', collisions === 0, collisions + ' collisions');
  verifie(c.nom + ' — rien dans la derniere minute', tropTard === 0, tropTard + ' cas');
  verifie(c.nom + ' — rien dans les 20 premieres secondes', tropTot === 0, tropTot + ' cas');
  verifie(c.nom + ' — un planning non vide a chaque fois', vides === 0, vides + ' plannings vides');
}

console.log('\n=== 3. Les modes ecartes ===');
verifie('EMOM : rien de planifie',   on.planifierEncouragements(600, 'emom', 'fr').length === 0);
verifie('Tabata : rien de planifie', on.planifierEncouragements(240, 'tabata', 'fr').length === 0);
verifie('WOD de 4 min : trop court, on se tait', on.planifierEncouragements(240, 'wod', 'fr').length === 0);

console.log('\n=== 4. Les deux sacs de tirage ===');
const g = []; for (let i = 0; i < 3; i++) g.push(on.tirerEncouragement(false));
verifie('sac general : les 3 phrases sortent avant repetition', new Set(g).size === 3, g.join(','));
const g2 = []; for (let i = 0; i < 3; i++) g2.push(on.tirerEncouragement(false));
verifie('sac general : le tour suivant repasse par les 3', new Set(g2).size === 3, g2.join(','));
const f = []; for (let i = 0; i < 3; i++) f.push(on.tirerEncouragement(true));
verifie('sac final : ne rend que enc4', f.every(k => k === 'enc4'), f.join(','));
verifie('aucune phrase du sac final dans le sac general', !g.concat(g2).includes('enc4'));

console.log('\n=== 5. La fenetre finale (2 dernieres minutes) ===');
let sansFinale = 0, finaleHorsFenetre = 0, generalTropBas = 0, plusieursFinales = 0;
for (let i = 0; i < 500; i++){
  const plan = on.planifierEncouragements(720, 'amrap', 'fr');
  const fin = plan.filter(e => e.finale);
  if (!fin.length) sansFinale++;
  if (fin.length > 1) plusieursFinales++;
  for (const e of fin) if (e.r <= 60 || e.r >= 120) finaleHorsFenetre++;
  for (const e of plan.filter(e => !e.finale)) if (e.r <= 120) generalTropBas++;
}
verifie('un encouragement final a chaque wod', sansFinale === 0, sansFinale + ' wod sans');
verifie('jamais deux finaux', plusieursFinales === 0, plusieursFinales + ' cas');
verifie('le final tombe bien entre 2 min et 1 min', finaleHorsFenetre === 0, finaleHorsFenetre + ' cas');
verifie('aucun general sous 2 min (la fenetre appartient a enc4)', generalTropBas === 0, generalTropBas + ' cas');

console.log('\n=== 6. Le cas concret : AMRAP 12 min ===');
const occ12 = on.encReperesOccupes(720, 'amrap', 'fr');
console.log('  reperes existants (sec restantes) :', [...new Set(occ12)].sort((a,b)=>b-a).join(', '));
const ex = on.planifierEncouragements(720, 'amrap', 'fr');
console.log('  planning tire au sort :');
for (const e of ex){
  const t = 720 - e.r;
  console.log(`    ${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}  (${e.r}s restantes)  ${e.finale ? 'sac FINAL  -> enc4' : 'sac general -> enc1/2/3'}`);
}
// 01/09/2026 : ENCOURAGEMENTS_INTERVALLE est passe de 240 s a 180 s. Sur 12 min on
// attend donc 4 prises de parole et non plus 3 (3 generaux + 1 final).
verifie('4 encouragements sur 12 min : 3 generaux + 1 final', ex.length === 4, ex.length + '');

console.log('\n' + (echecs ? `${echecs}/${tests} ECHECS` : `${tests}/${tests} verifications vertes`) + '\n');
process.exit(echecs ? 1 : 0);
