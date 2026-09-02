#!/usr/bin/env python3
"""Rend le decompte 10 -> GO tel qu'on l'entend vraiment, pour ecoute A/B.

AVANT : fichiers d'origine + ancienne table d'onsets.
APRES : fichiers traites (docs/traiter-voix.py) + table remesuree le 02/09.

Avec et sans lit musical au niveau du ducking du decompte (DUCK_DECOMPTE=0.06).
"""
import subprocess, numpy as np, os, sys, wave
exec(open("docs/traiter-voix.py").read().split(chr(10)+"if __name__")[0])  # noqa
SR=44100
CHIFFRES=["10","9","8","7","6","5","4","3","2","1","go"]
DUCK=0.06

ANCIENNE={"max":{"fr":[0,0,0,0,0,0,0,0,0,0,60],"en":[0,0,0,40,0,80,60,60,0,0,0]},
          "nina":{"en":[0,0,0,0,40,60,0,0,0,0,0]},
          "leo":{"fr":[40,20,20,20,20,20,100,100,20,0,100]},
          "sam":{"fr":[60,0,0,0,0,0,0,0,60,0,0]}}
NOUVELLE={"max":{"fr":[0,0,0,0,0,0,0,0,0,0,50],"en":[0,0,0,10,0,0,0,0,0,0,0]},
          "nina":{"en":[0,0,0,0,0,30,0,0,0,0,0]},
          "leo":{"fr":[30,10,10,0,0,0,90,90,0,0,90]},
          "sam":{"fr":[60,0,0,0,0,0,0,0,60,0,0]}}
DOSSIER={"max":"","nina":"voix/nina/","leo":"voix/leo/","sam":"voix/sam/"}

def lire(p):
    r=subprocess.run(["ffmpeg","-v","quiet","-i",p,"-ac","1","-ar",str(SR),"-f","f32le","-"],
                     capture_output=True).stdout
    return np.frombuffer(r,dtype=np.float32).astype(np.float64)

def rendre(pack,lg,table,traite,musique,sortie):
    buf=np.zeros(int(SR*12.0))
    if musique:
        m=lire(musique)
        if len(m)>0:
            m=np.tile(m,int(len(buf)/len(m))+1)[:len(buf)]
            buf+=m*DUCK
    o0=table[0]
    for i,c in enumerate(CHIFFRES):
        f="%scount-%s-%s.mp3"%(DOSSIER[pack],lg,c)
        if not os.path.exists(f): continue
        if traite:
            tmp="/tmp/tv_%s_%s_%s.mp3"%(pack,lg,c)
            if not os.path.exists(tmp): traiter(f,tmp)
            f=tmp
        x=lire(f)
        d=int(SR*max(0,i*1000-table[i]+o0)/1000)
        n=min(len(x),len(buf)-d)
        if n>0: buf[d:d+n]+=x[:n]
    pk=np.abs(buf).max()
    if pk>0.98: buf*=0.98/pk
    w=wave.open(sortie,"wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((buf*32767).astype("<i2").tobytes()); w.close()
    return sortie
