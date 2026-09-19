// =====================================================================
// RELAIS « LE COACH DIT TON PRENOM » (REPS Pro), 19/09/2026
//
// L'app envoie : { prenom, coach, langue, jws }
//   - jws : une transaction StoreKit 2 signee par Apple (abonnement Pro en cours).
// Le relais :
//   1. verifie que le prenom est un prenom (lettres, 20 caracteres max, pas d'insulte) ;
//   2. verifie la signature Apple de la transaction (chaine x5c jusqu'a Apple Root CA G3)
//      et que c'est bien un abonnement REPS Pro non expire, non rembourse ;
//   3. demande a ElevenLabs les 3 phrases pour ce coach et cette langue ;
//   4. renvoie les 3 mp3 en base64. Le telephone les garde, il ne rappelle plus.
//
// La cle ElevenLabs vit UNIQUEMENT dans Vercel (variable ELEVENLABS_API_KEY, type Secret).
// Le depot est PUBLIC : ne jamais ecrire de cle ici.
// Aucune dependance : crypto et fetch de Node suffisent.
// =====================================================================
const crypto = require('crypto');

const BUNDLE_ID = 'pro.repsapp.app';
const PRO_IDS = new Set(['pro.repsapp.app.pro.mensuel', 'pro.repsapp.app.pro.annuel']);
// Empreinte SHA-256 de « Apple Root CA - G3 » (https://www.apple.com/certificateauthority/).
const APPLE_ROOT_G3 = '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';

// Meme voix et memes reglages que generate-voices-4.sh (voice REPS ELEVEN LABS).
const MODELE = 'eleven_multilingual_v2';
const REGLAGES = { stability: 0.50, similarity_boost: 0.75, style: 0.30, use_speaker_boost: true, speed: 0.85 };
const COACHS = {
  max:  { voix: 'YOq2y2Up4RgXP2HyXjE5', langues: ['en', 'pt'] },       // MUTANT
  nina: { voix: 'I2Pglj4Q2qLAAisoXk0I', langues: ['en', 'pt'] },       // MIKE
  sam:  { voix: 'bU2VfAdiOb2Gv2eZWlFq', langues: ['fr', 'en', 'pt'] }, // SAM
  leo:  { voix: 'PNEOx9fYrFW0IAe0IwKn', langues: ['fr'] },             // LEO
};

// Phrases validees par Francois le 19/09/2026. « training » garde partout.
const PHRASES = {
  fr: { bienvenue: p => `Welcome, ${p} !`, retour: p => `Welcome back, ${p} !`, question: p => `Quel est ton training aujourd'hui, ${p} ?` },
  en: { bienvenue: p => `Welcome, ${p}!`,  retour: p => `Welcome back, ${p}!`,  question: p => `What's your training today, ${p}?` },
  pt: { bienvenue: p => `Welcome, ${p}!`,  retour: p => `Welcome back, ${p}!`,  question: p => `Qual é o seu training hoje, ${p}?` },
};

// ---------------------------------------------------------------------
// 1. LE PRENOM
// ---------------------------------------------------------------------
// Mots refuses, sans accents, en minuscules. Un prenom qui CONTIENT un mot long de
// cette liste est refuse ; les mots courts (4 lettres ou moins) doivent correspondre
// exactement, sinon on bloquerait des vrais prenoms.
const INTERDITS = [
  // fr
  'connard', 'connasse', 'salope', 'salaud', 'encule', 'enculer', 'pute', 'putain', 'batard',
  'bite', 'couille', 'couilles', 'chatte', 'merde', 'nique', 'niquer', 'pd', 'pede', 'tapette',
  'negre', 'bougnoule', 'youpin', 'bicot', 'gouine', 'fdp', 'ntm', 'tg', 'ta gueule', 'suce', 'sucer',
  'cul', 'trouduc', 'abruti', 'debile', 'mongol', 'nazi', 'hitler', 'porno', 'sexe',
  // en
  'fuck', 'fucker', 'fucking', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'asshole', 'bastard',
  'whore', 'slut', 'nigger', 'nigga', 'faggot', 'fag', 'retard', 'penis', 'vagina', 'porn', 'sex', 'rape',
  'motherfucker', 'wanker', 'twat',
  // pt (Bresil)
  'porra', 'caralho', 'buceta', 'puta', 'viado', 'cu', 'merda', 'foda', 'foder', 'fodase', 'cacete',
  'arrombado', 'otario', 'vagabunda', 'piranha', 'corno', 'rola', 'xoxota', 'boceta', 'macaco',
];
function sansAccents(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

function verifierPrenom(brut) {
  if (typeof brut !== 'string') return { ok: false, raison: 'prenom_absent' };
  const p = brut.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (p.length < 1 || p.length > 20) return { ok: false, raison: 'prenom_longueur' };
  // Lettres de toutes les langues, espace, tiret, apostrophe. Commence par une lettre.
  if (!/^\p{L}[\p{L}\p{M}' \-’]*$/u.test(p)) return { ok: false, raison: 'prenom_caracteres' };
  const plat = sansAccents(p);
  const mots = plat.split(/[^a-z]+/).filter(Boolean);
  const colle = mots.join('');
  for (const m of INTERDITS) {
    const mm = m.replace(/ /g, '');
    if (mm.length <= 4) { if (mots.includes(mm) || colle === mm) return { ok: false, raison: 'prenom_refuse' }; }
    else if (colle.includes(mm)) return { ok: false, raison: 'prenom_refuse' };
  }
  return { ok: true, prenom: p };
}

// ---------------------------------------------------------------------
// 2. L'ABONNEMENT (transaction StoreKit 2 signee par Apple)
// ---------------------------------------------------------------------
function b64url(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

function verifierJws(jws, empreinteRacine) {
  if (typeof jws !== 'string') throw new Error('jws_absent');
  const morceaux = jws.split('.');
  if (morceaux.length !== 3) throw new Error('jws_format');
  const entete = JSON.parse(b64url(morceaux[0]).toString('utf8'));
  if (entete.alg !== 'ES256' || !Array.isArray(entete.x5c) || entete.x5c.length < 2) throw new Error('jws_entete');
  const certs = entete.x5c.map(c => new crypto.X509Certificate(
    `-----BEGIN CERTIFICATE-----\n${c}\n-----END CERTIFICATE-----`));
  const maintenant = new Date();
  for (const c of certs) {
    if (!(new Date(c.validFrom) < maintenant && maintenant < new Date(c.validTo))) throw new Error('jws_cert_date');
  }
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].checkIssued(certs[i + 1]) || !certs[i].verify(certs[i + 1].publicKey)) throw new Error('jws_chaine');
  }
  if (certs[certs.length - 1].fingerprint256 !== empreinteRacine) throw new Error('jws_racine');
  const ok = crypto.verify('sha256', Buffer.from(morceaux[0] + '.' + morceaux[1]),
    { key: certs[0].publicKey, dsaEncoding: 'ieee-p1363' }, b64url(morceaux[2]));
  if (!ok) throw new Error('jws_signature');
  const t = JSON.parse(b64url(morceaux[1]).toString('utf8'));
  if (t.bundleId !== BUNDLE_ID) throw new Error('pro_bundle');
  if (!PRO_IDS.has(t.productId)) throw new Error('pro_produit');
  if (t.revocationDate) throw new Error('pro_rembourse');
  if (!t.expiresDate || t.expiresDate < Date.now()) throw new Error('pro_expire');
  return t;
}

// ---------------------------------------------------------------------
// 3. ELEVENLABS
// ---------------------------------------------------------------------
async function generer(texte, voix, cle) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voix}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': cle, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text: texte, model_id: MODELE, voice_settings: REGLAGES }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    throw new Error(`elevenlabs_${r.status} ${detail}`);
  }
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

// ---------------------------------------------------------------------
// POINT D'ENTREE
// ---------------------------------------------------------------------
const ORIGINES = new Set(['capacitor://localhost', 'ionic://localhost']);

async function handler(req, res) {
  const origine = req.headers.origin || '';
  if (ORIGINES.has(origine)) {
    res.setHeader('Access-Control-Allow-Origin', origine);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'methode' });

  let corps = req.body;
  if (typeof corps === 'string') { try { corps = JSON.parse(corps); } catch (e) { corps = null; } }
  if (!corps || typeof corps !== 'object') return res.status(400).json({ erreur: 'corps' });

  const p = verifierPrenom(corps.prenom);
  if (!p.ok) return res.status(422).json({ erreur: p.raison });

  const coach = COACHS[corps.coach];
  const langue = corps.langue;
  if (!coach || !PHRASES[langue] || !coach.langues.includes(langue)) return res.status(400).json({ erreur: 'coach_langue' });

  try {
    verifierJws(corps.jws, APPLE_ROOT_G3);
  } catch (e) {
    return res.status(403).json({ erreur: 'pro', detail: e.message });
  }

  const cle = process.env.ELEVENLABS_API_KEY;
  if (!cle) return res.status(500).json({ erreur: 'cle_absente' });

  try {
    const ph = PHRASES[langue];
    const [bienvenue, retour, question] = await Promise.all([
      generer(ph.bienvenue(p.prenom), coach.voix, cle),
      generer(ph.retour(p.prenom), coach.voix, cle),
      generer(ph.question(p.prenom), coach.voix, cle),
    ]);
    return res.status(200).json({ prenom: p.prenom, coach: corps.coach, langue, mp3: { bienvenue, retour, question } });
  } catch (e) {
    console.error('prenom : ' + e.message);
    return res.status(502).json({ erreur: 'generation' });
  }
}

module.exports = handler;
module.exports.verifierPrenom = verifierPrenom;
module.exports.verifierJws = verifierJws;
