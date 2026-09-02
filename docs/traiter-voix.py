#!/usr/bin/env python3
"""Chaine de traitement des voix REPS : clarte d'abord, niveau ensuite.

Le probleme mesure le 02/09/2026 : les consonnes (bande 2-6 kHz) sont enfouies
sous la voyelle. MIKE en anglais est a -11,8 dB de presence, MUTANT en anglais a
-13,1, la ou LEO en francais est a -2,2. On n'entend pas « five », on entend
« aive ». Monter le volume ne change rien a ca, ca monte la voyelle aussi.

La chaine, dans l'ordre :
  1. passe-haut 110 Hz    : le grave n'aide aucun mot et mange de la marge
  2. -2,5 dB a 350 Hz     : degage la boue qui masque les consonnes
  3. +5 dB a 3,2 kHz      : la bande ou se joue l'intelligibilite
  4. +3,5 dB a 6 kHz      : les fricatives (s, f, ch)
  4b. porte de bruit      : sans elle le compresseur remonte la queue de
                            silence des fichiers (MUTANT « un » : 0,78 s dont la
                            moitie est du bruit de fond) et on entend du souffle
  5. compresseur 4:1      : resserre l'ecart voyelle/consonne
  6. gain vers une cible RMS commune : corrige le niveau irregulier d'une
     annonce a l'autre (aujourd'hui 3,5 dB d'ecart a l'interieur de MUTANT)
  7. limiteur a -1 dBTP   : plus d'ecretage (SAM etait deja a +0,1 dBTP)

Usage : python3 docs/traiter-voix.py <entree.mp3> <sortie.mp3>
"""
import subprocess, sys, numpy as np, os
SR=44100
CIBLE_RMS_DB = -9.0   # RMS de la partie sonore, apres traitement.
# Mesure des originaux : MIKE -9,9 / LEO -11,5 / MUTANT -12,3 / SAM -13,1 dBFS.
# A -9,0 tout le monde monte (de 0,9 dB pour MIKE a 4,1 dB pour SAM) ET se retrouve
# au meme niveau : la dispersion de 2 a 3,9 dB a l'interieur d'un pack disparait.

FILTRES = ("highpass=f=110:poles=2,"
           "agate=threshold=0.05:ratio=3:attack=5:release=120,"
           "equalizer=f=350:t=q:w=1.2:g=-2.5,"
           "equalizer=f=3200:t=q:w=1.2:g=5,"
           "equalizer=f=6000:t=q:w=1.5:g=3.5,"
           "acompressor=threshold=-22dB:ratio=4:attack=5:release=120")

def pcm(p, af=None):
    cmd=["ffmpeg","-v","quiet","-i",p]
    if af: cmd+=["-af",af]
    cmd+=["-ac","1","-ar",str(SR),"-f","f32le","-"]
    return np.frombuffer(subprocess.run(cmd,capture_output=True).stdout,dtype=np.float32)

def rms_sonore(x):
    if len(x)==0: return 0.0
    e=np.abs(x); pk=e.max()
    if pk<=0: return 0.0
    idx=np.where(e>pk*10**(-30/20))[0]
    if len(idx)==0: return 0.0
    y=x[idx[0]:idx[-1]+1]
    return float(np.sqrt((y.astype(np.float64)**2).mean()))

def traiter(src, dst, passes=3):
    """Deux ou trois passes : le limiteur rabote les cretes et fait donc RETOMBER
    le RMS sous la cible. On mesure la sortie reelle et on corrige le gain, sinon
    un fichier tres crete (SAM « dix », facteur de crete 13 dB) finit 4,6 dB
    sous la cible alors qu'on croit l'avoir calee."""
    y = pcm(src, FILTRES)
    if len(y) == 0: return None
    r = rms_sonore(y)
    if r <= 0: return None
    gain = 10**(CIBLE_RMS_DB/20) / r
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    for _ in range(passes):
        chaine = FILTRES + ",volume=%.5f,alimiter=limit=0.891:level=disabled" % gain
        subprocess.run(["ffmpeg","-y","-v","quiet","-i",src,"-af",chaine,
                        "-c:a","libmp3lame","-b:a","128k","-ar","44100","-ac","1",dst],check=True)
        obtenu = rms_sonore(pcm(dst))
        if obtenu <= 0: return None
        ecart = CIBLE_RMS_DB - 20*np.log10(obtenu)
        if abs(ecart) < 0.3: break
        gain *= 10**(ecart/20)
    return dst

if __name__=="__main__":
    print(traiter(sys.argv[1], sys.argv[2]))
