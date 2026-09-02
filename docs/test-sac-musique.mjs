// TEST — le sac de tirage musical survit d'un WOD a l'autre (31/08/2026)
//
// Regression visee : jusqu'au 31/08, _dejaJoues repartait a zero a chaque
// startMusic et firstKey valait toujours S.track. Le meme morceau ouvrait donc
// CHAQUE wod de la seance. C'est ce que Francois a entendu chez On Air le 27/08.
//
// Ce test extrait les VRAIES fonctions de index.html (pas une copie) et les
// execute avec des doublures pour tout ce qui touche au DOM et a l'audio.
//
//   node docs/test-sac-musique.mjs
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extraire(nom){
  const debut = html.indexOf('function ' + nom + '(');
  if (debut < 0) throw new Error('fonction introuvable : ' + nom);
  let i = html.indexOf('{', debut), prof = 0;
  for (let j = i; j < html.length; j++){
    if (html[j] === '{') prof++;
    else if (html[j] === '}' && --prof === 0) return html.slice(debut, j + 1);
  }
  throw new Error('accolade non fermee : ' + nom);
}

// --- doublures : tout ce que startMusic touche et qui n'existe pas hors navigateur
const harnais = `
let musicAudio=null, byoMusic=false, mixMode=null, manualPicks=[], _arretVoulu=false;
let _singleGenreMix=false, _shuffleCurrentKey=null, _dejaJoues=[], _sacNeuf=true;
const S={state:'playing', track:null};
const window={};
const ALL_TRACK_KEYS=['pogo','pleinfeu','techno','house','hymne','censured','cartier','crime','ringside','introduction','vibes'];
window.CATEGORY_TRACKS={rap:['pogo','pleinfeu'],techno:['techno'],house:['house'],hymne:['hymne'],
  hiphop:['censured','cartier','crime','ringside','introduction','vibes']};
window._mixCategory=null;
const MUSIC=Object.fromEntries(ALL_TRACK_KEYS.map(k=>[k,k+'.mp3']));
const DBG=()=>{}, busAttachEl=()=>{}, mixAttachMusic=()=>{}, setElVolume=()=>{};
const stopMusic=()=>{}, playNextShuffle=()=>{};
const _classList={remove(){},add(){},toggle(){}};
const document={body:{classList:_classList},getElementById:()=>null,
  querySelectorAll:()=>[],querySelector:()=>null};
const musicTargetVolume=()=>1, niveauMusique=()=>1, _watchMusic=()=>{};
const getCachedAudio=()=>({loop:false,currentTime:0,volume:1,onended:null,
  play:()=>Promise.resolve(),pause(){},_repsFini:false});
`;

const src = harnais
  + extraire('genreOfTrack') + '\n'
  + extraire('pickNextTrack') + '\n'
  + extraire('applyWizardMix').replace('_byoOff();','') + '\n'
  + extraire('startMusic') + '\n'
  + 'export const api={startMusic,applyWizardMix,get cle(){return _shuffleCurrentKey;},'
  + 'get sac(){return _dejaJoues.slice();},set track(v){S.track=v;}};';

const { api } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let echecs = 0, tests = 0;
function verifie(nom, cond, detail){
  tests++;
  if (cond) console.log('  ok   ' + nom);
  else { echecs++; console.log('  ECHEC ' + nom + (detail ? '  -> ' + detail : '')); }
}

function seance(categorie, premier, nbWod){
  api.applyWizardMix(categorie);
  api.track = premier;
  const ouvertures = [];
  for (let i = 0; i < nbWod; i++){ api.startMusic(); ouvertures.push(api.cle); }
  return ouvertures;
}

console.log('\n=== TECHNO (le cas pire : un seul morceau dans le genre) ===');
let o = seance('techno', 'techno', 6);
console.log('  ouvertures :', o.join(' -> '));
verifie('le 1er wod respecte le choix du coach', o[0] === 'techno', o[0]);
verifie('aucune ouverture identique deux wod de suite',
        o.every((k, i) => i === 0 || k !== o[i - 1]), o.join(','));
verifie('techno n\'ouvre pas les 3 premiers wod (le bug du 27/08)',
        !(o[0] === 'techno' && o[1] === 'techno' && o[2] === 'techno'));
verifie('au moins 5 morceaux differents sur 6 wod', new Set(o).size >= 5, [...new Set(o)].join(','));

console.log('\n=== HIP-HOP (6 morceaux) ===');
o = seance('hiphop', 'cartier', 6);
console.log('  ouvertures :', o.join(' -> '));
verifie('le 1er wod respecte le choix', o[0] === 'cartier', o[0]);
verifie('les 6 ouvertures sont toutes differentes', new Set(o).size === 6, o.join(','));

console.log('\n=== un nouveau choix musical remet le sac a zero ===');
api.applyWizardMix('hiphop'); api.track = 'crime'; api.startMusic();
const apresChoix = api.cle;
verifie('re-choisir un morceau le rejoue en ouverture', apresChoix === 'crime', apresChoix);

console.log('\n=== 30 wod d\'affilee : aucun morceau ne sort trop souvent ===');
o = seance('techno', 'techno', 30);
const compte = {};
o.forEach(k => compte[k] = (compte[k] || 0) + 1);
const max = Math.max(...Object.values(compte));
console.log('  repartition :', JSON.stringify(compte));
verifie('aucun morceau n\'ouvre plus de 5 wod sur 30', max <= 5, 'max=' + max);
verifie('les 11 morceaux servent tous', Object.keys(compte).length === 11,
        Object.keys(compte).length + ' morceaux');

console.log('\n' + (echecs ? `${echecs}/${tests} ECHECS` : `${tests}/${tests} verifications vertes`) + '\n');
process.exit(echecs ? 1 : 0);
