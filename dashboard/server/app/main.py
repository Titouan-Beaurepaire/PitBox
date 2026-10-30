"""PitBox — serveur de télémétrie.

La R4 pousse ses trames sur /ws/ingest ; le dashboard les reçoit en direct
sur /ws/live et consulte les sessions passées par l'API REST.
Tout ce qui se passe (R4, voiture, serveur) est noté dans le journal : /api/journal.
"""
import asyncio
import csv
import hmac
import io
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

from . import db, sauvegarde
from .trame import CANAUX, decoder_codes, decoder_evenement, decoder_journal_sd, decoder_trame

TOKEN = os.environ.get("PITBOX_TOKEN", "")
DONNEES = Path(os.environ.get("PITBOX_DATA", "data"))
NOUVELLE_SESSION_APRES = 600  # s sans trame : la voiture a été arrêtée
REDEMARRAGE_R4 = 10           # un seq qui recule de plus que ça = la R4 a redémarré
BILAN_TRAMES = 60             # s entre deux bilans des trames abîmées ou manquantes
RAPPEL_JETON = 600            # s : un même boîtier au mauvais jeton n'est noté qu'une fois par période

# Mêmes seuils que le dashboard (web/lib/telemetrie.ts)
TEMP_CHAUD, TEMP_SURCHAUFFE = 105, 115
TENSION_CHARGE_MIN, TENSION_MAX, TENSION_BATTERIE_FAIBLE = 130, 150, 118
CONFIRMATION_BATTERIE = 3000  # ms : ignore le creux de tension du démarreur

journal_log = logging.getLogger("pitlabs")
journal_log.setLevel(logging.INFO)
_sortie = logging.StreamHandler(sys.stdout)   # visible avec : docker compose logs server
_sortie.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
journal_log.addHandler(_sortie)
NIVEAUX_LOG = {"info": logging.INFO, "attention": logging.WARNING, "alerte": logging.ERROR}

# Gravité des événements envoyés par la R4 (les codes inconnus sont des infos)
NIVEAUX_R4 = {
    "ECU_MUET": "attention", "WIFI_PERDU": "attention", "SERVEUR_PERDU": "attention",
    "CAN_ERREUR": "alerte", "SD_ERREUR": "alerte", "ENVOI_REFUSE": "alerte",
}


class SessionCourante:
    """La session en cours d'enregistrement (une seule voiture)."""
    id: int | None = None
    dernier_seq = -1
    derniere_trame = 0.0

    def reprendre(self) -> None:
        derniere = db.derniere_session()
        if derniere and derniere["seq_max"] is not None:
            self.id, self.dernier_seq, self.derniere_trame = derniere["id"], derniere["seq_max"], derniere["fin"]

    def accepter(self, seq: int) -> tuple[int | None, str | None, int]:
        """Renvoie (session de la trame ou None si doublon, raison si nouvelle session, trames sautées)."""
        maintenant = time.time()
        raison = None
        if self.id is None:
            raison = "première trame reçue"
        elif seq < self.dernier_seq - REDEMARRAGE_R4:
            raison = f"la R4 a redémarré (trame {self.dernier_seq} puis {seq})"
        elif maintenant - self.derniere_trame > NOUVELLE_SESSION_APRES:
            raison = f"reprise après {(maintenant - self.derniere_trame) / 60:.0f} min sans trame"
        elif seq <= self.dernier_seq:
            return None, None, 0
        sautees = 0 if raison else seq - self.dernier_seq - 1
        if raison:
            self.id = db.creer_session()
        self.dernier_seq, self.derniere_trame = seq, maintenant
        return self.id, raison, sautees


class Suivi:
    """Compare chaque mesure à la précédente pour noter ce qui change côté voiture."""

    def __init__(self) -> None:
        self.voyant: int | None = None
        self.temp = "normale"
        self.batterie: str | None = None
        self.batterie_candidate: tuple[str | None, int] | None = None   # (état, depuis t_ms)

    @staticmethod
    def _niveau_temp(temp: int, actuel: str) -> str:
        brut = "surchauffe" if temp >= TEMP_SURCHAUFFE else "chaud" if temp >= TEMP_CHAUD else "normale"
        seuils = {"surchauffe": TEMP_SURCHAUFFE, "chaud": TEMP_CHAUD}
        ordre = ["normale", "chaud", "surchauffe"]
        # 2 °C d'hystérésis à la descente : pas de clignotement autour du seuil
        if ordre.index(brut) < ordre.index(actuel) and temp > seuils[actuel] - 2:
            return actuel
        return brut

    @staticmethod
    def _batterie(tension: int, regime: int | None) -> str | None:
        moteur_tourne = regime is not None and regime > 500
        if tension > TENSION_MAX:
            return "surtension"
        if moteur_tourne and tension < TENSION_CHARGE_MIN:
            return "l'alternateur ne charge plus"
        if not moteur_tourne and tension < TENSION_BATTERIE_FAIBLE:
            return "batterie faible"
        return None

    def comparer(self, m: dict) -> list[tuple[str, str, str]]:
        """Renvoie les événements (niveau, code, message) apparus avec cette mesure."""
        sortie = []
        if m["voyant"] is not None:
            if m["voyant"] == 1 and self.voyant != 1:
                sortie.append(("alerte", "VOYANT_ON", f"voyant moteur allumé ({m['defauts'] or 0} code(s) défaut)"))
            elif m["voyant"] == 0 and self.voyant == 1:
                sortie.append(("info", "VOYANT_OFF", "voyant moteur éteint"))
            self.voyant = m["voyant"]
        if m["temp"] is not None:
            niveau = self._niveau_temp(m["temp"], self.temp)
            if niveau != self.temp:
                gravite = {"surchauffe": "alerte", "chaud": "attention", "normale": "info"}[niveau]
                sortie.append((gravite, f"TEMP_{niveau.upper()}", f"température moteur {niveau} : {m['temp']} °C"))
                self.temp = niveau
        if m["tension"] is not None:
            etat = self._batterie(m["tension"], m["regime"])
            if etat == self.batterie:
                self.batterie_candidate = None
            elif self.batterie_candidate is None or self.batterie_candidate[0] != etat:
                self.batterie_candidate = (etat, m["t_ms"])
            elif m["t_ms"] - self.batterie_candidate[1] >= CONFIRMATION_BATTERIE:
                volts = f"{m['tension'] / 10:.1f} V"
                if etat:
                    gravite = "alerte" if etat != "batterie faible" else "attention"
                    sortie.append((gravite, "BATTERIE", f"{etat} : {volts}"))
                else:
                    sortie.append(("info", "BATTERIE_OK", f"tension redevenue normale : {volts}"))
                self.batterie, self.batterie_candidate = etat, None
        return sortie


courante = SessionCourante()
suivi = Suivi()
spectateurs: set[WebSocket] = set()
connexions_r4 = 0  # plusieurs à la fois quand la R4 redémarre : l'ancienne se ferme après l'arrivée de la nouvelle
codes_defaut: list[str] = []  # derniers codes défaut envoyés par la R4
jetons_refuses: dict[str, float] = {}  # IP → dernière fois notée


async def diffuser(message: dict) -> None:
    for ws in list(spectateurs):
        try:
            await ws.send_json(message)
        except Exception:
            spectateurs.discard(ws)


COURANTE = -1  # noter() : rattacher l'événement à la session en cours


async def noter(niveau: str, source: str, code: str, message: str, t_ms: int | None = None, session_id: int | None = COURANTE) -> None:
    """Ajoute une ligne au journal : base, sortie du conteneur et dashboards ouverts.
    session_id=None : événement du serveur, sans session."""
    e = {"t": time.time(), "niveau": niveau, "source": source, "code": code, "message": message,
         "session_id": courante.id if session_id == COURANTE else session_id, "t_ms": t_ms}
    e["id"] = db.ajouter_evenement(e)
    journal_log.log(NIVEAUX_LOG[niveau], "[%s] %s : %s", source, code, message)
    await diffuser({"type": "evenement", **e})


async def sauvegardes_auto() -> None:
    while True:
        ecoule = sauvegarde.derniere_il_y_a()
        await asyncio.sleep(0 if ecoule is None else max(0, sauvegarde.PERIODE - ecoule))
        try:
            fichier, supprimees = await asyncio.to_thread(sauvegarde.sauvegarder)
            taille = fichier.stat().st_size / 1e6
            await noter("info", "serveur", "SAUVEGARDE", f"{fichier.name} ({taille:.1f} Mo), {supprimees} ancienne(s) supprimée(s)", session_id=None)
        except Exception as erreur:
            await noter("alerte", "serveur", "SAUVEGARDE_ERREUR", f"sauvegarde impossible : {erreur}", session_id=None)
        await asyncio.sleep(600)   # au moins 10 min entre deux essais, même après un échec


@asynccontextmanager
async def demarrage(_: FastAPI):
    db.ouvrir(DONNEES / "pitbox.db")
    courante.reprendre()
    await noter("info", "serveur", "SERVEUR_DEMARRE", "serveur PitLabs démarré", session_id=None)
    tache = asyncio.create_task(sauvegardes_auto()) if sauvegarde.PERIODE > 0 else None
    yield
    if tache:
        tache.cancel()


app = FastAPI(title="PitBox", lifespan=demarrage)


# ---------------------------------------------------------------- temps réel

@app.websocket("/ws/ingest")
async def ingest(ws: WebSocket, token: str = ""):
    """La R4 envoie une ou plusieurs trames par message, séparées par des retours à la ligne."""
    global connexions_r4, codes_defaut
    ip = ws.client.host if ws.client else "?"
    if not TOKEN or not hmac.compare_digest(token, TOKEN):
        if time.time() - jetons_refuses.get(ip, 0) > RAPPEL_JETON:
            jetons_refuses[ip] = time.time()
            await noter("alerte", "serveur", "JETON_REFUSE", f"connexion refusée depuis {ip} : jeton absent ou faux", session_id=None)
        await ws.close(code=1008)
        return
    await ws.accept()
    connexions_r4 += 1
    debut, recues, illisibles, sautees, doublons, dernier_bilan = time.time(), 0, 0, 0, 0, time.time()
    await noter("info", "serveur", "BOITIER_CONNECTE", f"R4 connectée depuis {ip}")
    await diffuser({"type": "boitier", "connecte": True})

    async def bilan() -> None:
        nonlocal illisibles, sautees, doublons, dernier_bilan
        if illisibles or sautees or doublons:
            details = [f"{n} {quoi}" for n, quoi in ((illisibles, "illisible(s) (somme de contrôle fausse)"),
                       (sautees, "manquante(s)"), (doublons, "en double")) if n]
            await noter("attention", "serveur", "TRAMES", f"trames {', '.join(details)} depuis {time.time() - dernier_bilan:.0f} s")
        illisibles = sautees = doublons = 0
        dernier_bilan = time.time()

    try:
        while True:
            par_session: dict[int, list[dict]] = {}
            evenements_r4 = []
            for ligne in (await ws.receive_text()).splitlines():
                if not ligne.strip():
                    continue
                if (codes := decoder_codes(ligne)) is not None:
                    for code in sorted(set(codes) - set(codes_defaut)):
                        await noter("alerte", "voiture", "CODE_APPARU", code)
                    for code in sorted(set(codes_defaut) - set(codes)):
                        await noter("info", "voiture", "CODE_DISPARU", code)
                    codes_defaut = codes
                    if courante.id is not None:
                        db.noter_codes(courante.id, codes)
                    await diffuser({"type": "defauts", "codes": codes})
                    continue
                if (evenement := decoder_evenement(ligne)) is not None:
                    evenements_r4.append(evenement)
                    continue
                mesure = decoder_trame(ligne)
                if not mesure:
                    illisibles += 1
                    continue
                session, raison, trous = courante.accepter(mesure["seq"])
                if session is None:
                    doublons += 1
                    continue
                if raison:
                    suivi.__init__()   # nouvelle session : on repart de zéro (le voyant encore allumé sera renoté)
                    await noter("info", "serveur", "SESSION_NOUVELLE", f"session {session} : {raison}", session_id=session)
                sautees += trous
                recues += 1
                par_session.setdefault(session, []).append(mesure)
                for niveau, code, message in suivi.comparer(mesure):
                    await noter(niveau, "voiture", code, message, t_ms=mesure["t_ms"], session_id=session)
            for session, mesures in par_session.items():
                db.ajouter_live(session, mesures)
                for m in mesures:
                    await diffuser({"type": "mesure", "session": session, **m})
            # après les trames : au redémarrage de la R4, son événement DEMARRAGE va dans la nouvelle session
            for e in evenements_r4:
                niveau = NIVEAUX_R4.get(e["code"], "info")
                if e["code"] == "DEMARRAGE" and "sd=aucun" in e["detail"]:
                    niveau = "attention"
                await noter(niveau, "r4", e["code"], e["detail"], t_ms=e["t_ms"])
            if time.time() - dernier_bilan >= BILAN_TRAMES:
                await bilan()
    except WebSocketDisconnect:
        pass
    finally:
        connexions_r4 -= 1
        await bilan()
        await noter("attention", "serveur", "BOITIER_DECONNECTE",
                    f"R4 déconnectée après {(time.time() - debut) / 60:.1f} min, {recues} trames reçues")
        await diffuser({"type": "boitier", "connecte": connexions_r4 > 0})


@app.websocket("/ws/live")
async def live(ws: WebSocket):
    await ws.accept()
    spectateurs.add(ws)
    await ws.send_json({"type": "boitier", "connecte": connexions_r4 > 0})
    await ws.send_json({"type": "defauts", "codes": codes_defaut})
    try:
        while True:
            await ws.receive_text()  # le navigateur n'envoie rien : on attend juste la fermeture
    except WebSocketDisconnect:
        spectateurs.discard(ws)


# ---------------------------------------------------------------- sessions

def _verifier(session_id: int) -> None:
    if not db.session_existe(session_id):
        raise HTTPException(404, "Session introuvable")


@app.get("/api/sessions")
def sessions():
    return db.lister_sessions()


@app.get("/api/sessions/{session_id}/mesures")
def mesures(session_id: int, source: str = "auto"):
    """Données en colonnes (une liste par canal), le format attendu par les graphiques."""
    _verifier(session_id)
    if source == "auto":
        source = db.source_preferee(session_id)
    lignes = db.mesures(session_id, source)
    colonnes = {c: [l[c] for l in lignes] for c in ("t_ms", *CANAUX, "etat")}
    return {"source": source, **colonnes}


@app.get("/api/sessions/{session_id}/export.csv")
def exporter(session_id: int, source: str = "auto"):
    _verifier(session_id)
    if source == "auto":
        source = db.source_preferee(session_id)
    sortie = io.StringIO()
    ecrivain = csv.writer(sortie)
    ecrivain.writerow(("t_ms", *CANAUX, "etat"))
    ecrivain.writerows(tuple(l) for l in db.mesures(session_id, source))
    nom = f"pitbox_session_{session_id}_{source}.csv"
    return Response(sortie.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{nom}"'})


@app.post("/api/sessions/{session_id}/sd")
async def importer_sd(session_id: int, requete: Request):
    """Corps de la requête : le contenu brut du fichier SESSxxx.CSV de la carte SD."""
    _verifier(session_id)
    mesures = decoder_journal_sd((await requete.body()).decode("utf-8", "replace"))
    if not mesures:
        raise HTTPException(400, "Aucune ligne lisible dans ce fichier")
    db.remplacer_sd(session_id, mesures)
    await noter("info", "serveur", "SD_IMPORT", f"journal SD importé dans la session {session_id} : {len(mesures)} lignes", session_id=session_id)
    return {"importees": len(mesures)}


@app.delete("/api/sessions/{session_id}")
async def supprimer(session_id: int, requete: Request):
    _verifier(session_id)
    db.supprimer_session(session_id)
    if courante.id == session_id:
        courante.id = None
    ip = requete.client.host if requete.client else "?"
    await noter("attention", "serveur", "SESSION_SUPPRIMEE", f"session {session_id} supprimée depuis {ip}", session_id=session_id)
    return {"ok": True}


# ---------------------------------------------------------------- journal

@app.get("/api/journal")
def journal(limite: int = 200, avant: int | None = None, session: int | None = None, niveau: str = "", source: str = ""):
    """Événements, les plus récents d'abord. niveau / source : listes séparées par des virgules."""
    return db.evenements(min(max(limite, 1), 1000), avant, session,
                         [n for n in niveau.split(",") if n], [s for s in source.split(",") if s])


@app.get("/api/sauvegardes")
def sauvegardes():
    return [{"nom": f.name, "taille": f.stat().st_size, "date": f.stat().st_mtime} for f in reversed(sauvegarde.existantes())]
