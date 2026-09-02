#!/usr/bin/env python3
"""Mesure le silence de tete de chaque fichier du decompte, pack par pack.

Convention (celle des mesures du 16/08 et du 25/08) : fenetres de 20 ms,
seuil a -20 dB sous le pic du fichier. Valeur arrondie a 5 ms.

Sortie : le bloc COUNT_ONSET_VOIX pret a coller dans index.html.
Une colonne STABILITE signale les fichiers dont l'onset bouge de plus de
20 ms quand on change le seuil : attaque molle, valeur a prendre avec des
pincettes.
"""
import subprocess, numpy as np, os, sys
SR = 44100
CHIFFRES = ["10","9","8","7","6","5","4","3","2","1","go"]
PACKS = [("max","",["fr","en","pt"]), ("nina","voix/nina/",["fr","en","pt"]),
         ("sam","voix/sam/",["fr","en","pt"]), ("eva","voix/eva/",["fr","en","pt"]),
         ("leo","voix/leo/",["fr"])]

def pcm(p):
    r = subprocess.run(["ffmpeg","-v","quiet","-i",p,"-ac","1","-ar",str(SR),"-f","f32le","-"],
                       capture_output=True).stdout
    return np.frombuffer(r, dtype=np.float32)

def onset_ms(x, rel_db=-20.0, win_ms=20):
    if len(x) == 0: return 0
    pk = np.abs(x).max()
    if pk <= 0: return 0
    thr = pk * 10**(rel_db/20)
    w = int(SR*win_ms/1000); pas = w//2
    for i in range(0, max(1, len(x)-w), pas):
        if np.abs(x[i:i+w]).max() > thr:
            return int(round(i/SR*1000/5)*5)
    return 0

def main():
    lignes, alertes = {}, []
    for cle, dossier, langues in PACKS:
        lignes[cle] = {}
        for lg in langues:
            vals, insta = [], []
            for c in CHIFFRES:
                f = "%scount-%s-%s.mp3" % (dossier, lg, c)
                if not os.path.exists(f):
                    vals.append(0); continue
                x = pcm(f)
                v = onset_ms(x)
                autres = [onset_ms(x, -15.0), onset_ms(x, -25.0)]
                if max(abs(a-v) for a in autres) > 20:
                    insta.append("%s(%d/%d/%d)" % (c, autres[0], v, autres[1]))
                vals.append(v)
            lignes[cle][lg] = vals
            if insta: alertes.append("  %s %s : %s" % (cle, lg, " ".join(insta)))
    print("const COUNT_ONSET_VOIX={")
    for cle, _, langues in PACKS:
        parts = ["%s:[%s]" % (lg, ",".join(str(v) for v in lignes[cle][lg])) for lg in langues]
        print("  %-5s: { %s },"%(cle, ", ".join(parts)))
    print("};")
    if alertes:
        print("\n// ATTAQUES MOLLES (onset sensible au seuil, -15/-20/-25 dB) :")
        print("\n".join(alertes))

if __name__ == "__main__":
    main()
