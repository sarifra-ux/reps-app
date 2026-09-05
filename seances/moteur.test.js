// Tests du moteur des séances multi-blocs. `node moteur.test.js`.
// Aucune dépendance : ça doit tourner partout, tout le temps, en une seconde.

const M = require('./moteur.js');

let ko = 0;
function ok(nom, cond, detail) {
  console.log((cond ? '  OK   ' : '  ECHEC') + ' ' + nom + (detail ? '  [' + detail + ']' : ''));
  if (!cond) ko++;
}
const mmss = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

const s = M.seance77();

console.log('=== ' + s.nom + ' ===');
M.horaires(s).forEach(h => {
  const b = h.bloc;
  const quoi = b.type === 'intervalle'
    ? `${b.tours} x ${b.work}s` + (b.rest ? ` / ${b.rest}s rest` : '')
    : (b.type === 'repos' ? 'repos' : 'cap');
  console.log('  ' + String(mmss(h.debut)).padStart(6) + ' – ' + String(mmss(h.fin)).padStart(6) +
              '  ' + (b.titre || b.type).padEnd(10) + ' ' + quoi);
});
console.log('  total : ' + mmss(s.duree));

console.log('\n=== durées ===');
ok('un bloc intervalle vaut tours x (work+rest)', M.dureeBloc({type:'intervalle',work:60,rest:15,tours:10}) === 750);
ok('le premier bloc OLY fait 6 min', M.dureeBloc(s.blocs[0]) === 360, mmss(M.dureeBloc(s.blocs[0])));
ok('l\'EMOM 15 fait 15 min', M.dureeBloc(s.blocs[4]) === 900);
ok('Every 5 x 5 fait 25 min', M.dureeBloc(s.blocs[6]) === 1500);

console.log('\n=== position ===');
const p0 = M.positionDansSeance(s, 0);
ok('à 0 s : premier bloc, tour 1, work', p0.index === 0 && p0.tour === 1 && p0.phase === 'work');
const p89 = M.positionDansSeance(s, 89);
ok('à 89 s : encore le tour 1', p89.tour === 1, 'tour ' + p89.tour);
const p90 = M.positionDansSeance(s, 90);
ok('à 90 s : tour 2', p90.tour === 2, 'tour ' + p90.tour);
const p359 = M.positionDansSeance(s, 359);
ok('à 5:59 : dernier tour du bloc 1', p359.index === 0 && p359.tour === 4, 'bloc ' + p359.index + ' tour ' + p359.tour);
const p360 = M.positionDansSeance(s, 360);
ok('à 6:00 : on bascule sur le repos de 60 s', p360.index === 1 && p360.phase === 'repos');
const pFin = M.positionDansSeance(s, s.duree - 1);
ok('à la dernière seconde : METCON', pFin.bloc.titre === 'METCON' && pFin.dernierBloc === true);
ok('après la fin : plus de position', M.positionDansSeance(s, s.duree) === null);

console.log('\n=== continuité (aucun trou, aucun recouvrement) ===');
let trous = 0, blocVu = -1, sauts = 0;
for (let t = 0; t < s.duree; t++) {
  const p = M.positionDansSeance(s, t);
  if (!p) { trous++; continue; }
  if (p.index < blocVu) sauts++;          // on ne revient jamais en arrière
  blocVu = p.index;
}
ok('chaque seconde de la séance a une position', trous === 0, trous + ' trou(s)');
ok('les blocs se suivent sans retour en arrière', sauts === 0);

console.log('\n=== repères ===');
const r = M.reperes(s);
const debuts = r.filter(x => x.type === 'debut-bloc').length;
const tours = r.filter(x => x.type === 'tour').length;
ok('un début par bloc', debuts === s.blocs.length, debuts + ' / ' + s.blocs.length);
ok('un repère par tour au-delà du premier', tours === (4 - 1) + (2 - 1) + (15 - 1) + (5 - 1), tours + '');
ok('les repères sont dans l\'ordre', r.every((x, i) => i === 0 || x.at >= r[i - 1].at));
ok('le dernier repère est la fin de séance', r[r.length - 1].type === 'fin-seance' && r[r.length - 1].at === s.duree);

console.log('\n=== ce que le programme de la coach dit, et ce qu\'il dure vraiment ===');
// Ses horaires annoncés, à comparer avec le calcul.
const annonces = [[0, 1500], [1500, 1980], [1980, 3480], [3480, 4020], [4020, 4620]];
const calcules = [
  [0, M.dureeBloc(s.blocs[0]) + M.dureeBloc(s.blocs[1]) + M.dureeBloc(s.blocs[2]) + M.dureeBloc(s.blocs[3]) + M.dureeBloc(s.blocs[4])],
];
const bloc1 = calcules[0][1];
console.log('  bloc OLY : annoncé ' + mmss(1500) + ', calculé ' + mmss(bloc1) +
            '  -> écart de ' + mmss(Math.abs(bloc1 - 1500)));
console.log('  séance    : annoncée ' + mmss(4620) + ', calculée ' + mmss(s.duree) +
            '  -> écart de ' + mmss(Math.abs(s.duree - 4620)));
ok('l\'écart est bien détecté, il n\'est pas nul', bloc1 !== 1500);

console.log('\n=== enchaînement : les deux modes ===');
ok('par défaut, la séance est en liste', s.enchainement === 'manuel', s.enchainement);
const auto = M.creerSeance('test', [{type:'repos',duree:60},{type:'repos',duree:30}], {enchainement:'auto'});
ok('on peut demander l\'enchaînement automatique', auto.enchainement === 'auto');

// Mode 'auto' : le temps court d'un bout à l'autre.
ok('auto : à 70 s on est dans le deuxième bloc', M.positionDansSeance(auto, 70).index === 1);

// Mode 'manuel' : chaque bloc repart de zéro, c'est le coach qui fait avancer.
const etat = M.demarrerEnListe(s);
ok('liste : on démarre sur le premier bloc', etat.index === 0 && etat.dansBloc === 0);
etat.dansBloc = 100;
const pl = M.positionEnListe(etat);
ok('liste : à 100 s du premier bloc, tour 2', pl.tour === 2, 'tour ' + pl.tour);
ok('liste : le bloc ne connaît pas le temps de la séance', pl.resteSeance === undefined);
etat.dansBloc = M.dureeBloc(s.blocs[0]);
ok('liste : en fin de bloc, on attend le coach', M.positionEnListe(etat).attendLeCoach === true);
ok('liste : le play fait avancer d\'un bloc', M.blocSuivant(etat) === true && etat.index === 1 && etat.dansBloc === 0);
let fin = M.demarrerEnListe(s); fin.index = s.blocs.length - 1;
ok('liste : pas de bloc après le dernier', M.blocSuivant(fin) === false);

// Le calcul interne est le MÊME dans les deux modes : c'est ce qui garantit qu'un
// changement d'avis sur l'enchaînement ne touche pas le cœur du chrono.
const parSeance = M.positionDansSeance(s, 100);
const parBloc = M.positionDansBloc(s.blocs[0], 100);
ok('les deux chemins donnent la même phase et le même tour',
   parSeance.tour === parBloc.tour && parSeance.phase === parBloc.phase &&
   parSeance.restePhase === parBloc.restePhase);

console.log(ko ? '\n' + ko + ' ECHEC(S)' : '\nTout est vert');
process.exit(ko ? 1 : 0);
