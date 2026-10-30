"use client";

import { useEffect, useMemo, useRef } from "react";
import type uPlot from "uplot";
import Graphique, { type Serie } from "@/components/Graphique";
import { Voyant } from "@/components/Voyants";
import { descriptionCode } from "@/lib/codes";
import { useLive } from "@/lib/useLive";
import {
  COULEURS, ETATS, REGIME_MAX, REGIME_RALENTI, REGIME_RETRO, REGIME_SHIFT,
  alerteBatterie, niveauTemp, volts, type Colonnes, type Mesure, type Session,
} from "@/lib/telemetrie";

const FENETRE_S = 60; // secondes affichées sur les courbes live

const SERIES_MOTEUR: Serie[] = [
  { label: "Régime", couleur: COULEURS.regime, axe: "gauche", unite: "tr/min" },
  { label: "Papillon", couleur: COULEURS.papillon, axe: "droite", unite: "%" },
];
const SERIES_VOITURE: Serie[] = [
  { label: "Vitesse", couleur: COULEURS.vitesse, axe: "gauche", unite: "km/h" },
  { label: "Température", couleur: COULEURS.temp, axe: "droite", unite: "°C" },
];

type Historique = { session: number | null; mesures: Mesure[] };

// À l'ouverture de la page, reprend la fin de la session en cours pour ne pas partir de courbes vides
async function prefiller(h: Historique): Promise<Mesure | null> {
  try {
    const [session] = (await (await fetch("/api/sessions")).json()) as Session[];
    if (!session || Date.now() / 1000 - session.fin > 30) return null;
    const c = (await (await fetch(`/api/sessions/${session.id}/mesures?source=live`)).json()) as Colonnes;
    if (h.session !== null && h.session !== session.id) return null;
    const debutLive = h.mesures[0]?.t_ms ?? Infinity;
    const fin = c.t_ms[c.t_ms.length - 1];
    const anciennes: Mesure[] = c.t_ms.flatMap((t_ms, i) =>
      t_ms >= fin - FENETRE_S * 1000 && t_ms < debutLive
        ? [{
            session: session.id, seq: -1, t_ms, regime: c.regime[i], temp: c.temp[i], vitesse: c.vitesse[i], charge: c.charge[i],
            papillon: c.papillon[i], etat: c.etat[i], voyant: c.voyant[i], defauts: c.defauts[i], tension: c.tension[i],
          }]
        : [],
    );
    h.session = session.id;
    h.mesures.unshift(...anciennes);
    return anciennes[anciennes.length - 1] ?? null;
  } catch {
    return null;
  }
}

export default function Live() {
  const historique = useRef<Historique>({ session: null, mesures: [] });
  const { serveur, boitier, derniere, setDerniere, silence, codes } = useLive((msg) => {
    const h = historique.current;
    if (h.session !== msg.session) {
      h.session = msg.session;
      h.mesures.length = 0;
    }
    h.mesures.push(msg);
    while (h.mesures.length && h.mesures[0].t_ms < msg.t_ms - FENETRE_S * 1000) h.mesures.shift();
  });

  useEffect(() => {
    prefiller(historique.current).then((m) => m && setDerniere((d) => d ?? m));
  }, [setDerniere]);

  // recalculé à chaque nouvelle mesure
  const [moteur, voiture] = useMemo(() => {
    const m = historique.current.mesures;
    const t = m.map((x) => x.t_ms / 1000);
    return [
      [t, m.map((x) => x.regime), m.map((x) => x.papillon)],
      [t, m.map((x) => x.vitesse), m.map((x) => x.temp)],
    ] as uPlot.AlignedData[];
  }, [derniere]);

  const etat = derniere && silence !== null && silence < 3 ? derniere.etat : null;
  const regime = derniere?.regime ?? null;
  const temp = niveauTemp(derniere?.temp ?? null);
  const batterie = alerteBatterie(derniere?.tension ?? null, regime);
  const voyantMoteur = derniere?.voyant === 1;
  const zone = regime === null ? "" : regime >= REGIME_SHIFT ? "shift" : regime > REGIME_RALENTI && regime < REGIME_RETRO ? "retro" : "";

  return (
    <>
      <div className="entete">
        <h1>Live {derniere && <span className="message">· session {derniere.session}</span>}</h1>
        <div className="statuts">
          <span className={`pastille ${serveur ? "ok" : "alerte"}`}>Serveur</span>
          <span className={`pastille ${boitier ? "ok" : "alerte"}`}>Boîtier {boitier ? "connecté" : "déconnecté"}</span>
          <span className={`pastille ${etat === 1 ? "ok" : etat === 2 ? "alerte" : "attention"}`}>
            Voiture : {etat === null ? "aucune trame" : ETATS[etat]}
          </span>
          {silence !== null && <span className="pastille">Dernière trame il y a {silence.toFixed(1)} s</span>}
        </div>
      </div>

      <div className="tuiles">
        <div className="tuile large">
          <div className="nom">Régime</div>
          <div className="valeur">{regime ?? "—"}<small>tr/min</small></div>
          <div className={`compte-tours ${zone}`}>
            <div className="aiguille" style={{ width: `${Math.min(100, ((regime ?? 0) / REGIME_MAX) * 100)}%` }} />
            <div className="repere" style={{ left: `${(REGIME_SHIFT / REGIME_MAX) * 100}%` }} />
          </div>
          <div className="detail">
            {zone === "shift" ? <span className="ok">Passe la vitesse</span> : zone === "retro" ? <span className="froid">Rétrograde</span> : " "}
          </div>
        </div>
        <div className="tuile">
          <div className="nom">Vitesse</div>
          <div className="valeur">{derniere?.vitesse ?? "—"}<small>km/h</small></div>
        </div>
        <div className="tuile">
          <div className="nom">Température moteur</div>
          <div className={`valeur ${temp.classe}`}>{derniere?.temp ?? "—"}<small>°C</small></div>
          <div className={`detail ${temp.classe}`}>{temp.texte}</div>
        </div>
        <div className="tuile">
          <div className="nom">Papillon</div>
          <div className="valeur">{derniere?.papillon ?? "—"}<small>%</small></div>
          <div className="jauge"><div style={{ width: `${derniere?.papillon ?? 0}%`, background: COULEURS.papillon }} /></div>
        </div>
        <div className="tuile">
          <div className="nom">Charge moteur</div>
          <div className="valeur">{derniere?.charge ?? "—"}<small>%</small></div>
          <div className="jauge"><div style={{ width: `${derniere?.charge ?? 0}%`, background: COULEURS.charge }} /></div>
        </div>
        <div className="tuile large">
          <div className="nom">Voyants</div>
          <div className="voyants">
            <Voyant type="moteur" titre="Voyant moteur" couleur="orange" allume={voyantMoteur} />
            <Voyant type="batterie" titre={batterie ?? "Batterie"} couleur="rouge" allume={batterie !== null} />
            <Voyant type="temperature" titre="Température moteur" couleur="rouge" allume={temp.classe === "alerte"} clignote />
          </div>
          <div className="detail">
            {derniere?.voyant == null ? "Voyant moteur inconnu" : voyantMoteur ? <span className="attention">Voyant moteur allumé</span> : "Aucun voyant"}
          </div>
          {codes.length > 0 && (
            <ul className="codes">
              {codes.map((c) => <li key={c}><b>{c}</b>{descriptionCode(c)}</li>)}
            </ul>
          )}
        </div>
        <div className="tuile">
          <div className="nom">Batterie</div>
          <div className={`valeur ${batterie ? "alerte" : ""}`}>{volts(derniere?.tension ?? null)}<small>V</small></div>
          <div className={`detail ${batterie ? "alerte" : ""}`}>{batterie ?? (derniere?.tension != null ? "Normale" : " ")}</div>
        </div>
      </div>

      <h2>Moteur · {FENETRE_S} dernières secondes</h2>
      <Graphique series={SERIES_MOTEUR} donnees={moteur} />
      <h2>Voiture</h2>
      <Graphique series={SERIES_VOITURE} donnees={voiture} hauteur={200} />
    </>
  );
}
