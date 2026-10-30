"""Joue le rôle de la R4 : envoie au serveur des trames identiques à celles de la R4
en mode SIMULATION, avec des pertes et des coupures comme en 4G.

usage : python simulateur_r4.py [url] [jeton] [--sd fichier.csv]
  --sd écrit aussi le journal complet, comme la carte SD de la R4, pour tester l'import.
"""
import argparse
import asyncio
import random
import time

import websockets

INCONNU = -100


def mesure(t_ms: int) -> list[int]:
    """Mêmes formules que simulerDonnees() dans le code de la R4."""
    cycle = t_ms % 10000
    monte = cycle < 5000
    regime = 800 + (7000 - 800) * cycle // 5000 if monte else 7000 - (7000 - 800) * (cycle - 5000) // 5000
    temp = 20 + (125 - 20) * (t_ms % 60000) // 60000
    vitesse = (regime - 800) * 180 // (7000 - 800)
    papillon = 100 if monte else 0
    charge = 40 + (95 - 40) * (regime - 800) // (7000 - 800) if monte else 15
    voyant = int(30000 <= t_ms % 60000 < 45000)   # voyant moteur 15 s par minute
    return [regime, temp, vitesse, charge, papillon, 1, voyant, 2 * voyant, 141]


def codes(t_ms: int) -> list[str]:
    return ["P0301", "P0420"] if mesure(t_ms)[6] else []


def signer(debut: str, corps: str) -> str:
    ck = 0
    for octet in corps.encode():
        ck ^= octet
    return f"{debut}{corps}*{ck:02X}"


def evenement(t_ms: int, code: str, detail: str) -> str:
    """Comme noterEvenement() dans le code de la R4."""
    return signer("#", f"E,{t_ms},{code},{detail}")


def trame(seq: int, t_ms: int) -> str:
    return signer("$", ",".join(map(str, [seq, t_ms, *mesure(t_ms)])))


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("url", nargs="?", default="ws://localhost:8000/ws/ingest")
    p.add_argument("jeton", nargs="?", default="dev")
    p.add_argument("--sd", help="écrit aussi le journal SD complet dans ce fichier")
    p.add_argument("--duree", type=float, default=0, help="s, 0 = sans fin")
    args = p.parse_args()

    sd = open(args.sd, "w") if args.sd else None
    if sd:
        sd.write("t_ms,regime,temp,vitesse,charge,papillon,etat,voyant,defauts,tension\n")

    debut = time.monotonic()
    seq = 0
    tampon: list[str] = []   # trames gardées pendant une coupure, comme le fait la R4
    ws = None
    coupe_jusqua = 0.0
    derniers_codes: list[str] | None = None
    rappel_codes = 0.0
    tampon.append(evenement(0, "DEMARRAGE", "simulation=1 can=ok sd=SESS000.CSV"))
    tampon.append(evenement(0, "ETAT_OK", "donnees OK"))
    debut_coupure = 0.0
    while not args.duree or time.monotonic() - debut < args.duree:
        t_ms = int((time.monotonic() - debut) * 1000)
        if sd:  # la SD reçoit tout, deux fois plus souvent que le live
            sd.write(",".join(map(str, [t_ms, *mesure(t_ms)])) + "\n")
            sd.write(",".join(map(str, [t_ms + 50, *mesure(t_ms + 50)])) + "\n")
        if random.random() > 0.02:   # 2 % de trames perdues en route
            tampon.append(trame(seq, t_ms))
        if codes(t_ms) != derniers_codes or time.monotonic() - rappel_codes > 5:   # comme envoyerCodes()
            derniers_codes, rappel_codes = codes(t_ms), time.monotonic()
            tampon.append(signer("#", ",".join(["D", *derniers_codes])))
        seq += 1

        try:
            if time.monotonic() < coupe_jusqua:
                pass   # pas de réseau : les trames s'accumulent dans le tampon
            elif ws is None:
                ws = await websockets.connect(f"{args.url}?token={args.jeton}")
                print(f"connecté, {len(tampon)} trames en attente")
                if debut_coupure:
                    tampon.insert(0, evenement(t_ms, "SERVEUR_OK", f"apres 1 essai(s), coupure {time.monotonic() - debut_coupure:.0f} s, 0 trames ecrasees"))
                    debut_coupure = 0.0
            elif random.random() < 0.003:   # coupure réseau d'environ 3 s
                await ws.close()
                ws = None
                coupe_jusqua = time.monotonic() + 3
                debut_coupure = time.monotonic()
                tampon.append(evenement(t_ms, "SERVEUR_PERDU", "connexion WebSocket coupee"))
                print("coupure")
            if ws is not None and time.monotonic() >= coupe_jusqua:
                await ws.send("\n".join(tampon))
                tampon.clear()
        except (OSError, websockets.ConnectionClosed, websockets.InvalidStatus) as e:
            ws = None
            coupe_jusqua = time.monotonic() + 1
            print("pas de connexion :", e)
        await asyncio.sleep(0.1)

    if sd:
        sd.close()


if __name__ == "__main__":
    asyncio.run(main())
