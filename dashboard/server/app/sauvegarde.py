"""Sauvegarde automatique de la base SQLite.

Toutes les PITBOX_SAUVEGARDE_HEURES heures, une copie compressée part dans
PITBOX_SAUVEGARDES (le dossier sauvegardes/ du VPS) ; on garde les PITBOX_SAUVEGARDE_GARDER
plus récentes. À la main : docker compose exec server python -m app.sauvegarde
"""
import gzip
import os
import shutil
import time
from pathlib import Path

from . import db

DOSSIER = Path(os.environ.get("PITBOX_SAUVEGARDES", "sauvegardes"))
PERIODE = float(os.environ.get("PITBOX_SAUVEGARDE_HEURES", "6")) * 3600
GARDER = int(os.environ.get("PITBOX_SAUVEGARDE_GARDER", "40"))   # 10 jours à une toutes les 6 h


def existantes() -> list[Path]:
    return sorted(DOSSIER.glob("pitbox-*.db.gz"))


def derniere_il_y_a() -> float | None:
    """Secondes depuis la dernière sauvegarde, None s'il n'y en a aucune."""
    liste = existantes()
    return time.time() - liste[-1].stat().st_mtime if liste else None


def sauvegarder() -> tuple[Path, int]:
    """Renvoie le fichier créé et le nombre d'anciennes sauvegardes supprimées."""
    DOSSIER.mkdir(parents=True, exist_ok=True)
    final = DOSSIER / f"pitbox-{time.strftime('%Y%m%d-%H%M%S')}.db.gz"
    brut = final.with_suffix(".tmp")
    db.sauvegarder(brut)
    with open(brut, "rb") as entree, gzip.open(final.with_suffix(".tmp.gz"), "wb") as sortie:
        shutil.copyfileobj(entree, sortie)
    brut.unlink()
    final.with_suffix(".tmp.gz").rename(final)   # le fichier n'apparaît qu'une fois complet
    anciennes = existantes()[:-GARDER]
    for f in anciennes:
        f.unlink()
    return final, len(anciennes)


if __name__ == "__main__":
    db.ouvrir(Path(os.environ.get("PITBOX_DATA", "data")) / "pitbox.db")
    fichier, supprimees = sauvegarder()
    print(f"{fichier} ({fichier.stat().st_size / 1e6:.1f} Mo), {supprimees} ancienne(s) supprimée(s)")
