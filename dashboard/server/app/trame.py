"""Décodage des messages PitBox.

Trame live (R4 → serveur) : $seq,t_ms,regime,temp,vitesse,charge,papillon,etat[,voyant,defauts,tension]*CK
Codes défaut              : #D[,P0301,P0420...]*CK
Événement de la R4        : #E,t_ms,CODE,detail*CK
Ligne du journal SD       : t_ms,regime,temp,vitesse,charge,papillon,etat[,voyant,defauts,tension]

Les trois derniers champs sont optionnels (anciennes versions du code de la R4, boîtier ELM327).
La tension est en dixièmes de volt.
"""
import re

INCONNU = -100  # valeur jamais reçue de la voiture
CANAUX = ("regime", "temp", "vitesse", "charge", "papillon", "voyant", "defauts", "tension")
CHAMPS_SD = ("t_ms", *CANAUX[:5], "etat", *CANAUX[5:])
CHAMPS_TRAME = ("seq", *CHAMPS_SD)
OPTIONNELS = 3
CODE = re.compile(r"[PCBU][0-3][0-9A-F]{3}")
CODE_EVENEMENT = re.compile(r"[A-Z_]{2,24}")


def _entiers(texte: str, champs: tuple[str, ...]) -> dict | None:
    morceaux = texte.split(",")
    if len(morceaux) not in (len(champs), len(champs) - OPTIONNELS):
        return None
    try:
        mesure = dict(zip(champs, map(int, morceaux)))
    except ValueError:
        return None
    for canal in CANAUX:
        if mesure.get(canal, INCONNU) == INCONNU:
            mesure[canal] = None
    return mesure if 0 <= mesure["etat"] <= 2 else None


def _verifier(ligne: str, debut: str) -> str | None:
    """Renvoie le corps du message si la somme de contrôle est bonne."""
    ligne = ligne.strip()
    if not ligne.startswith(debut):
        return None
    corps, etoile, ck = ligne[1:].partition("*")
    if not etoile or len(ck) < 2:
        return None
    calcule = 0
    for octet in corps.encode():
        calcule ^= octet
    try:
        return corps if int(ck[:2], 16) == calcule else None
    except ValueError:
        return None


def decoder_trame(ligne: str) -> dict | None:
    """Renvoie la mesure, ou None si la trame est mal formée ou abîmée."""
    corps = _verifier(ligne, "$")
    return _entiers(corps, CHAMPS_TRAME) if corps else None


def decoder_codes(ligne: str) -> list[str] | None:
    """Renvoie la liste des codes défaut (vide si aucun), ou None si ce n'est pas un message de codes."""
    corps = _verifier(ligne, "#")
    if not corps or not corps.startswith("D"):
        return None
    codes = corps.split(",")[1:]
    return codes if all(CODE.fullmatch(c) for c in codes) else None


def decoder_evenement(ligne: str) -> dict | None:
    """Renvoie {t_ms, code, detail}, ou None si ce n'est pas un événement de la R4."""
    corps = _verifier(ligne, "#")
    if not corps or not corps.startswith("E,"):
        return None
    t_ms, _, reste = corps[2:].partition(",")
    code, _, detail = reste.partition(",")
    if not t_ms.isdigit() or not CODE_EVENEMENT.fullmatch(code):
        return None
    return {"t_ms": int(t_ms), "code": code, "detail": detail}


def decoder_journal_sd(texte: str) -> list[dict]:
    """Lit un fichier SESSxxx.CSV ; ignore l'en-tête et les lignes illisibles."""
    return [m for ligne in texte.splitlines() if (m := _entiers(ligne.strip(), CHAMPS_SD))]
