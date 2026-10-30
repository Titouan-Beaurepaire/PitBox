"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useLive } from "@/lib/useLive";
import { Voyant } from "@/components/Voyants";
import {
  REGIME_RALENTI, REGIME_RETRO, REGIME_SHIFT, TEMP_FROID, TEMP_MAJEUR, TEMP_MINEUR, alerteBatterie,
} from "@/lib/telemetrie";
import "./dash.css";

const NB_LEDS = 15;
const SHIFT_DEBUT = 4000; // tr/min : première LED allumée
const DONNEES_PERIMEES = 2; // s sans trame : l'affichage n'est plus fiable

// Couleur de chaque LED, comme une rampe de shift light : vert, jaune, rouge
const COULEUR_LED = Array.from({ length: NB_LEDS }, (_, i) => (i < 5 ? "vert" : i < 10 ? "jaune" : "rouge"));

export default function Dash() {
  const { serveur, boitier, derniere, silence, codes } = useLive();
  const [demarre, setDemarre] = useState(false);
  const verrou = useRef<WakeLockSentinel | null>(null);

  // L'écran ne doit pas se mettre en veille pendant la conduite ; le verrou saute quand l'onglet est masqué
  useEffect(() => {
    if (!demarre) return;
    const reprendre = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        verrou.current = await navigator.wakeLock?.request("screen");
      } catch {}
    };
    reprendre();
    document.addEventListener("visibilitychange", reprendre);
    return () => {
      document.removeEventListener("visibilitychange", reprendre);
      verrou.current?.release();
    };
  }, [demarre]);

  const demarrer = async () => {
    try {
      await document.documentElement.requestFullscreen();
      await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape");
    } catch {} // pas de plein écran sur iPhone : on garde l'affichage normal
    setDemarre(true);
  };

  const frais = derniere !== null && silence !== null && silence < DONNEES_PERIMEES;
  const ok = frais && derniere.etat === 1;
  const regime = ok ? derniere.regime : null;
  const temp = ok ? derniere.temp : null;

  const voyantMoteur = ok && derniere.voyant === 1;
  const batterie = ok ? alerteBatterie(derniere.tension, regime) : null;

  const shift = regime !== null && regime >= REGIME_SHIFT;
  const retro = regime !== null && regime > REGIME_RALENTI && regime < REGIME_RETRO;
  const ledsAllumees = regime === null ? 0 : Math.ceil(((regime - SHIFT_DEBUT) / (REGIME_SHIFT - SHIFT_DEBUT)) * NB_LEDS);

  const niveauTemp =
    temp === null ? "" : temp >= TEMP_MAJEUR ? "alerte" : temp >= TEMP_MINEUR ? "attention" : temp < TEMP_FROID ? "froid" : "";

  const panne = !serveur
    ? "Pas de réseau"
    : !boitier
      ? "Boîtier déconnecté"
      : !frais
        ? "Pas de données"
        : derniere.etat === 2
          ? "Erreur CAN"
          : derniere.etat === 0
            ? "Voiture coupée"
            : null;

  const alerte =
    temp !== null && temp >= TEMP_MAJEUR ? { texte: "Surchauffe", classe: "alerte clignote" }
    : temp !== null && temp >= TEMP_MINEUR ? { texte: "Température haute", classe: "attention" }
    : retro ? { texte: "Rétrograde", classe: "froid" }
    : temp !== null && temp < TEMP_FROID ? { texte: "Moteur froid", classe: "froid discret" }
    : null;

  return (
    <div className={`dash ${shift ? "shift" : ""} ${niveauTemp === "alerte" ? "cadre-alerte" : ""} ${panne ? "inactif" : ""}`}>
      <div className="leds" aria-hidden="true">
        {COULEUR_LED.map((couleur, i) => (
          <span key={i} className={`led ${couleur} ${shift ? "bleu" : i < ledsAllumees ? "allumee" : ""}`} />
        ))}
      </div>

      <div className="cadran">
        <section className="cote">
          <div className="etiquette">Eau</div>
          <div className={`moyen ${niveauTemp}`}>{temp ?? "—"}<small>°C</small></div>
          <Barre valeur={ok ? derniere.papillon : null} nom="Papillon" couleur="vert" />
        </section>

        <section className="centre">
          <div className={`regime ${shift ? "bleu-texte" : ""}`}>{regime ?? "----"}</div>
          <div className="etiquette">tr/min</div>
          <div className="vitesse">{ok ? derniere.vitesse ?? "—" : "—"}<small>km/h</small></div>
        </section>

        <section className="cote">
          <div className="etiquette">Charge</div>
          <div className="moyen">{ok ? derniere.charge ?? "—" : "—"}<small>%</small></div>
          <Barre valeur={ok ? derniere.charge : null} nom="Charge" couleur="jaune" />
        </section>
      </div>

      <div className="pied">
        <span className={`point ${serveur && boitier && frais ? "ok" : "ko"}`} />
        <span>{panne ?? (silence !== null ? `${(silence * 1000).toFixed(0)} ms` : "")}</span>
        <span className="voyants">
          <Voyant type="moteur" titre="Voyant moteur" couleur="orange" allume={voyantMoteur} />
          <Voyant type="batterie" titre={batterie ?? "Batterie"} couleur="rouge" allume={batterie !== null} />
          <Voyant type="temperature" titre="Température moteur" couleur="rouge" allume={niveauTemp === "alerte"} clignote />
          {voyantMoteur && codes.length > 0 && <span className="codes-dash">{codes.join(" · ")}</span>}
        </span>
        {alerte && !panne && <span className={`bandeau ${alerte.classe}`}>{alerte.texte}</span>}
        <Link href="/" className="retour">PitLabs</Link>
      </div>

      {panne && <div className="panne">{panne}</div>}

      {!demarre && (
        <button className="demarrer" onClick={demarrer}>
          <span className="logo" />
          Démarrer le dash
          <small>plein écran, paysage, écran toujours allumé</small>
        </button>
      )}
    </div>
  );
}

function Barre({ valeur, nom, couleur }: { valeur: number | null; nom: string; couleur: string }) {
  return (
    <div className="jauge-verticale">
      <div className="barre-verticale">
        <div className={couleur} style={{ height: `${valeur ?? 0}%` }} />
      </div>
      <span className="etiquette">{nom}</span>
    </div>
  );
}
