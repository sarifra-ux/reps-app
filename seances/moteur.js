// ===== MOTEUR DES SÉANCES EN PLUSIEURS BLOCS (05/09/2026) =====
//
// Étape 1 du cadrage (CLAUDE.md/REPS-cadrage-seances-multiblocs.md) : le modèle et le
// calcul de position, SANS interface et SANS être branché à l'app. Ce fichier n'est
// référencé nulle part dans index.html, il ne peut donc rien casser du build en review.
//
// Trois primitives couvrent tout le programme de la coach :
//
//   intervalle  work + rest répétés N fois     EMOM, E90"MOM, Every 5', Tabata
//   repos       une durée, rien d'autre        les 8 min, les 9 min, les 60"
//   libre       un temps plafond               for time avec cap, AMRAP
//
// Le mode actuel de l'app est le cas particulier « séance à un seul bloc ». C'est ce qui
// permettra de brancher tout ça sans rien casser : ce qui existe continue de marcher.
//
// Toutes les durées sont en secondes. Aucune dépendance, aucun effet de bord : ce fichier
// se teste tout seul, ce qui est exactement le but de l'étape 1.

'use strict';

// --- Construction -----------------------------------------------------------

function bloc(def) {
  const b = Object.assign({}, def);
  if (b.type === 'intervalle') {
    b.work = Math.max(1, b.work | 0);
    b.rest = Math.max(0, b.rest | 0);
    b.tours = Math.max(1, b.tours | 0);
  } else if (b.type === 'repos') {
    b.duree = Math.max(1, b.duree | 0);
  } else if (b.type === 'libre') {
    b.cap = Math.max(1, b.cap | 0);
  } else {
    throw new Error('type de bloc inconnu : ' + b.type);
  }
  return b;
}

function dureeBloc(b) {
  if (b.type === 'intervalle') return b.tours * (b.work + b.rest);
  if (b.type === 'repos') return b.duree;
  if (b.type === 'libre') return b.cap;
  return 0;
}

// ENCHAÎNEMENT (tranché avec François le 05/09) : les deux, avec un interrupteur.
//
//   'manuel' (défaut)  le coach prépare 4 ou 5 WOD la veille, ils sont en liste. En cours
//                      il lance le premier, explique le mouvement, lance le suivant quand
//                      la classe est prête. Rien ne décale si une explication déborde.
//   'auto'             les 78 minutes se déroulent sans intervention, repos compris.
//                      Fidèle au tableau du coach, et c'est le mode d'un test chronométré.
//
// Le moteur porte les deux : en 'auto' le temps est continu sur toute la séance, en
// 'manuel' chaque bloc repart de zéro. Le calcul de position à l'intérieur d'un bloc,
// lui, est le même dans les deux cas — c'est tout l'intérêt d'avoir séparé les deux.
function creerSeance(nom, defs, options) {
  const o = options || {};
  const blocs = defs.map(bloc);
  return {
    nom: nom,
    blocs: blocs,
    enchainement: (o.enchainement === 'auto') ? 'auto' : 'manuel',
    duree: blocs.reduce((t, b) => t + dureeBloc(b), 0),
  };
}

// Horaires absolus de chaque bloc, comme un coach les écrit au tableau : 0:00–25:00.
// C'est la vue qui permet de comparer ce que l'app calcule avec ce qui est prévu, et
// donc d'attraper un programme qui ne tombe pas juste.
function horaires(seance) {
  let t = 0;
  return seance.blocs.map((b, i) => {
    const debut = t, fin = t + dureeBloc(b);
    t = fin;
    return { index: i, debut: debut, fin: fin, bloc: b };
  });
}

// --- Position ---------------------------------------------------------------

// Où en est-on à `elapsed` secondes du début de la séance ?
// Renvoie null si la séance est finie.
//
// La logique interne d'un bloc `intervalle` est celle d'emomPos, volontairement : c'est
// du code éprouvé, on ne le réécrit pas, on l'enveloppe.
// Position À L'INTÉRIEUR d'un bloc. Sert aux deux modes d'enchaînement : c'est le seul
// calcul dont a besoin le mode manuel, où chaque bloc repart de zéro.
function positionDansBloc(b, dans) {
  const d = dureeBloc(b);
  if (dans < 0) dans = 0;
  if (dans >= d) return null; // bloc terminé
  const pos = { bloc: b, dansBloc: dans, resteBloc: d - dans };
  if (b.type === 'intervalle') {
    const cycle = b.work + b.rest;
    const tour = Math.floor(dans / cycle) + 1;
    const dansTour = dans - (tour - 1) * cycle;
    const enWork = dansTour < b.work;
    pos.phase = enWork ? 'work' : 'rest';
    pos.tour = tour;
    pos.tours = b.tours;
    pos.dansPhase = enWork ? dansTour : dansTour - b.work;
    pos.restePhase = (enWork ? b.work : cycle) - dansTour;
  } else {
    pos.phase = (b.type === 'repos') ? 'repos' : 'libre';
    pos.tour = 1;
    pos.tours = 1;
    pos.dansPhase = dans;
    pos.restePhase = d - dans;
  }
  return pos;
}

// Position dans une séance ENCHAÎNÉE ('auto'), où le temps court d'un bout à l'autre.
function positionDansSeance(seance, elapsed) {
  if (elapsed < 0) elapsed = 0;
  let t = 0;
  for (let i = 0; i < seance.blocs.length; i++) {
    const b = seance.blocs[i];
    const d = dureeBloc(b);
    if (elapsed < t + d) {
      const pos = positionDansBloc(b, elapsed - t);
      pos.index = i;
      pos.resteSeance = seance.duree - elapsed;
      pos.dernierBloc = (i === seance.blocs.length - 1);
      return pos;
    }
    t += d;
  }
  return null; // séance terminée
}

// Séance 'manuel' : le coach lance un bloc à la fois. L'état tient en deux nombres, et
// c'est le bouton play qui fait avancer l'index, jamais l'horloge.
function demarrerEnListe(seance) {
  return { seance: seance, index: 0, dansBloc: 0 };
}
function positionEnListe(etat) {
  const b = etat.seance.blocs[etat.index];
  if (!b) return null;
  const pos = positionDansBloc(b, etat.dansBloc) || positionDansBloc(b, dureeBloc(b) - 1);
  pos.index = etat.index;
  pos.dernierBloc = (etat.index === etat.seance.blocs.length - 1);
  pos.attendLeCoach = (etat.dansBloc >= dureeBloc(b));
  return pos;
}
function blocSuivant(etat) {
  if (etat.index >= etat.seance.blocs.length - 1) return false;
  etat.index++;
  etat.dansBloc = 0;
  return true;
}

// Les instants où quelque chose doit être dit ou affiché. Calculés UNE fois au
// lancement, comme le planning des encouragements : rien ne se décide pendant le WOD.
function reperes(seance) {
  const out = [];
  let t = 0;
  seance.blocs.forEach((b, i) => {
    out.push({ at: t, type: 'debut-bloc', index: i, bloc: b });
    if (b.type === 'intervalle') {
      const cycle = b.work + b.rest;
      for (let r = 0; r < b.tours; r++) {
        if (r > 0) out.push({ at: t + r * cycle, type: 'tour', index: i, tour: r + 1 });
        if (b.rest > 0) out.push({ at: t + r * cycle + b.work, type: 'repos', index: i, tour: r + 1 });
      }
    }
    t += dureeBloc(b);
  });
  out.push({ at: t, type: 'fin-seance' });
  return out;
}

// --- Le cas de test : le programme de la coach ------------------------------
// 77 FEET MADNESS, transcrit à la main. Aucune analyse de texte ici : c'est justement
// la question ouverte du cadrage, et on ne la tranche pas dans le moteur.

function seance77() {
  return creerSeance('77 FEET MADNESS', [
    { type: 'intervalle', titre: 'OLY', work: 90, rest: 0, tours: 4,
      notes: '1 High Hang Power Snatch + 1 OHSQ / 1 Hang Power Snatch + 1 OHSQ / 1 Power Snatch + 1 OHSQ' },
    { type: 'repos', duree: 60 },
    { type: 'intervalle', work: 90, rest: 0, tours: 2, notes: '70%' },
    { type: 'repos', duree: 60 },
    { type: 'intervalle', work: 60, rest: 0, tours: 15,
      notes: '1- 60 Heavy Double Unders / 2- 5-4-3-2-1 Power Snatch / 3- Rest' },
    { type: 'repos', duree: 480 },
    { type: 'intervalle', titre: 'Every 5', work: 300, rest: 0, tours: 5,
      notes: '5 Sandbag Clean (90/70) / 20m Bearhug Carry / 10 Ring Muscle-ups' },
    { type: 'repos', duree: 540 },
    { type: 'libre', titre: 'METCON', cap: 600,
      notes: '80 Wall Balls / 60 Toes to Bar / 40 Burpees Box Jumps' },
  ]);
}

if (typeof module !== 'undefined') {
  module.exports = { creerSeance, dureeBloc, horaires, positionDansBloc, positionDansSeance,
                     demarrerEnListe, positionEnListe, blocSuivant, reperes, seance77 };
}
