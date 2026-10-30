"""Stockage SQLite des sessions et des mesures."""
import sqlite3
import time
from pathlib import Path

from .trame import CANAUX

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id      INTEGER PRIMARY KEY,
  debut   REAL NOT NULL,      -- heure du serveur (epoch, s)
  fin     REAL NOT NULL,
  seq_min INTEGER,
  seq_max INTEGER,
  defauts_vus TEXT NOT NULL DEFAULT ''   -- codes défaut apparus pendant la session, séparés par des virgules
);
CREATE TABLE IF NOT EXISTS mesures (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,   -- 'live' (reçue en direct) ou 'sd' (journal de la R4)
  t_ms       INTEGER NOT NULL, -- horloge de la R4
  seq        INTEGER,
  regime INTEGER, temp INTEGER, vitesse INTEGER, charge INTEGER, papillon INTEGER,
  etat       INTEGER NOT NULL,
  voyant INTEGER, defauts INTEGER,
  tension    INTEGER          -- dixièmes de volt
);
CREATE INDEX IF NOT EXISTS mesures_session ON mesures(session_id, source, t_ms);
CREATE TABLE IF NOT EXISTS evenements (
  id         INTEGER PRIMARY KEY,
  t          REAL NOT NULL,     -- heure du serveur (epoch, s)
  niveau     TEXT NOT NULL,     -- 'info', 'attention' ou 'alerte'
  source     TEXT NOT NULL,     -- 'r4', 'voiture' (déduit des mesures) ou 'serveur'
  code       TEXT NOT NULL,
  message    TEXT NOT NULL,
  session_id INTEGER,           -- gardé même si la session est supprimée
  t_ms       INTEGER            -- horloge de la R4, pour ses propres événements
);
CREATE INDEX IF NOT EXISTS evenements_session ON evenements(session_id, id);
"""

COLONNES = ("t_ms", *CANAUX, "etat")
_cx: sqlite3.Connection | None = None
_chemin: Path | None = None


def ouvrir(chemin: Path) -> None:
    global _cx, _chemin
    _chemin = chemin
    chemin.parent.mkdir(parents=True, exist_ok=True)
    _cx = sqlite3.connect(chemin, check_same_thread=False)
    _cx.row_factory = sqlite3.Row
    _cx.execute("PRAGMA journal_mode=WAL")
    _cx.execute("PRAGMA foreign_keys=ON")
    _cx.executescript(SCHEMA)
    _migrer()


def _migrer() -> None:
    """Ajoute aux bases créées par une version précédente les colonnes apparues depuis."""
    nouvelles = {
        "sessions": {"defauts_vus": "TEXT NOT NULL DEFAULT ''"},
        "mesures": {"voyant": "INTEGER", "defauts": "INTEGER", "tension": "INTEGER"},
    }
    with _cx:
        for table, colonnes in nouvelles.items():
            existantes = {l["name"] for l in _cx.execute(f"PRAGMA table_info({table})")}
            for nom, definition in colonnes.items():
                if nom not in existantes:
                    _cx.execute(f"ALTER TABLE {table} ADD COLUMN {nom} {definition}")


def creer_session() -> int:
    """Numéro jamais réutilisé, même après une suppression : le journal garde les anciens numéros."""
    maintenant = time.time()
    with _cx:
        suivant = _cx.execute(
            "SELECT MAX(COALESCE((SELECT MAX(id) FROM sessions), 0), COALESCE((SELECT MAX(session_id) FROM evenements), 0)) + 1"
        ).fetchone()[0]
        return _cx.execute("INSERT INTO sessions (id, debut, fin) VALUES (?, ?, ?)", (suivant, maintenant, maintenant)).lastrowid


def derniere_session() -> sqlite3.Row | None:
    return _cx.execute("SELECT id, seq_max, fin FROM sessions ORDER BY id DESC LIMIT 1").fetchone()


def ajouter_live(session_id: int, mesures: list[dict]) -> None:
    seqs = [m["seq"] for m in mesures]
    with _cx:
        _cx.executemany(
            f"INSERT INTO mesures (session_id, source, seq, {', '.join(COLONNES)}) VALUES (?, 'live', ?, {', '.join('?' * len(COLONNES))})",
            [(session_id, m["seq"], *(m[c] for c in COLONNES)) for m in mesures],
        )
        _cx.execute(
            "UPDATE sessions SET fin = ?, seq_min = MIN(COALESCE(seq_min, ?), ?), seq_max = MAX(COALESCE(seq_max, ?), ?) WHERE id = ?",
            (time.time(), min(seqs), min(seqs), max(seqs), max(seqs), session_id),
        )


def noter_codes(session_id: int, codes: list[str]) -> None:
    vus = _cx.execute("SELECT defauts_vus FROM sessions WHERE id = ?", (session_id,)).fetchone()["defauts_vus"]
    tous = sorted(set(filter(None, vus.split(","))) | set(codes))
    with _cx:
        _cx.execute("UPDATE sessions SET defauts_vus = ? WHERE id = ?", (",".join(tous), session_id))


def remplacer_sd(session_id: int, mesures: list[dict]) -> None:
    with _cx:
        _cx.execute("DELETE FROM mesures WHERE session_id = ? AND source = 'sd'", (session_id,))
        _cx.executemany(
            f"INSERT INTO mesures (session_id, source, {', '.join(COLONNES)}) VALUES (?, 'sd', {', '.join('?' * len(COLONNES))})",
            [(session_id, *(m[c] for c in COLONNES)) for m in mesures],
        )


def lister_sessions() -> list[dict]:
    lignes = _cx.execute("""
        SELECT s.*,
          (SELECT COUNT(*) FROM mesures WHERE session_id = s.id AND source = 'live') AS nb_live,
          (SELECT COUNT(*) FROM mesures WHERE session_id = s.id AND source = 'sd')   AS nb_sd
        FROM sessions s ORDER BY s.id DESC
    """).fetchall()
    sessions = []
    for l in lignes:
        attendues = l["seq_max"] - l["seq_min"] + 1 if l["seq_max"] is not None else 0
        sessions.append({**dict(l), "trames_perdues": max(0, attendues - l["nb_live"])})
    return sessions


def session_existe(session_id: int) -> bool:
    return _cx.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,)).fetchone() is not None


def source_preferee(session_id: int) -> str:
    """Le journal SD est complet : il fait référence dès qu'il a été importé."""
    a_sd = _cx.execute("SELECT 1 FROM mesures WHERE session_id = ? AND source = 'sd' LIMIT 1", (session_id,)).fetchone()
    return "sd" if a_sd else "live"


def mesures(session_id: int, source: str) -> list[sqlite3.Row]:
    return _cx.execute(
        f"SELECT {', '.join(COLONNES)} FROM mesures WHERE session_id = ? AND source = ? ORDER BY t_ms",
        (session_id, source),
    ).fetchall()


def ajouter_evenement(e: dict) -> int:
    with _cx:
        return _cx.execute(
            "INSERT INTO evenements (t, niveau, source, code, message, session_id, t_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (e["t"], e["niveau"], e["source"], e["code"], e["message"], e["session_id"], e["t_ms"]),
        ).lastrowid


def evenements(limite: int, avant: int | None, session_id: int | None, niveaux: list[str], sources: list[str]) -> list[dict]:
    """Les plus récents d'abord ; `avant` (un id) pour charger la page suivante."""
    conditions, valeurs = [], []
    if avant is not None:
        conditions.append("id < ?"); valeurs.append(avant)
    if session_id is not None:
        conditions.append("session_id = ?"); valeurs.append(session_id)
    if niveaux:
        conditions.append(f"niveau IN ({', '.join('?' * len(niveaux))})"); valeurs += niveaux
    if sources:
        conditions.append(f"source IN ({', '.join('?' * len(sources))})"); valeurs += sources
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    lignes = _cx.execute(f"SELECT * FROM evenements {where} ORDER BY id DESC LIMIT ?", (*valeurs, limite))
    return [dict(l) for l in lignes]


def sauvegarder(chemin: Path) -> None:
    """Copie cohérente de la base, même pendant que la R4 écrit (API de sauvegarde de SQLite).
    Connexions à part : peut tourner dans un autre thread sans bloquer la réception des trames."""
    source, copie = sqlite3.connect(_chemin), sqlite3.connect(chemin)
    try:
        source.backup(copie)
    finally:
        source.close()
        copie.close()


def supprimer_session(session_id: int) -> None:
    with _cx:
        _cx.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
