#!/usr/bin/env python3
"""Applique docs/traiter-voix.py a TOUS les fichiers de voix des packs actifs.

EVA est exclue : le pack est retire de l'app depuis le 31/08/2026.
La musique et les effets (bip, tick, signal de depart) sont exclus : la chaine
est faite pour la parole, elle abimerait un morceau.

Les originaux sont dans git. Pour tout annuler : git checkout -- voix www/voix
plus les mp3 de la racine.

Usage : python3 docs/traiter-tous.py [debut] [fin]
"""
import os, sys, shutil, subprocess
sys.dont_write_bytecode=True
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"traiter-voix.py"))
     .read().split(chr(10)+"if __name__")[0])

PAS_DE_VOIX = {"beep.mp3","tick.mp3","start-signal.mp3","cartier.mp3","censured.mp3",
               "crime.mp3","house.mp3","hymne.mp3","introduction.mp3","pleinfeu.mp3",
               "pogo.mp3","ringside.mp3","techno.mp3","vibes.mp3"}

def liste():
    out=[]
    for f in sorted(os.listdir(".")):
        if not f.endswith(".mp3"): continue
        if f in PAS_DE_VOIX: continue
        if " 2." in f or ".backup-" in f or ".original-" in f or f.startswith("test-t"): continue
        out.append(f)
    for pack in ["voix/leo","voix/nina","voix/sam"]:      # EVA volontairement absente
        if not os.path.isdir(pack): continue
        for f in sorted(os.listdir(pack)):
            if f.endswith(".mp3") and " 2." not in f and ".backup-" not in f:
                out.append(os.path.join(pack,f))
    return out

if __name__=="__main__":
    fs=liste()
    a=int(sys.argv[1]) if len(sys.argv)>1 else 0
    b=int(sys.argv[2]) if len(sys.argv)>2 else len(fs)
    ok=ko=0
    for f in fs[a:b]:
        tmp="/tmp/tt_"+f.replace("/","_")
        try:
            if traiter(f,tmp) is None: ko+=1; continue
            shutil.move(tmp,f)
            miroir=os.path.join("www",f)
            if os.path.exists(os.path.dirname(miroir)):
                shutil.copyfile(f,miroir)
            ok+=1
        except Exception as e:
            ko+=1; print("KO",f,e)
    print("traites %d, echecs %d, total liste %d"%(ok,ko,len(fs)))
