"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type uPlot from "uplot";
import Graphique, { type Serie } from "@/components/Graphique";
import { descriptionCode } from "@/lib/codes";
import { COULEURS, duree, type Colonnes, type Session } from "@/lib/telemetrie";

const SERIES_MOTEUR: Serie[] = [
  { label: "Régime", couleur: COULEURS.regime, axe: "gauche", unite: "tr/min" },
  { label: "Papillon", couleur: COULEURS.papillon, axe: "droite", unite: "%" },
  { label: "Charge", couleur: COULEURS.charge, axe: "droite", unite: "%" },
];
const SERIES_VOITURE: Serie[] = [
  { label: "Vitesse", couleur: COULEURS.vitesse, axe: "gauche", unite: "km/h" },
  { label: "Température", couleur: COULEURS.temp, axe: "droite", unite: "°C" },
];
const SERIES_ELECTRIQUE: Serie[] = [
  { label: "Tension batterie", couleur: COULEURS.tension, axe: "gauche", unite: "V" },
  { label: "Voyant moteur", couleur: "#ff9f0a", axe: "droite", unite: "allumé" },
];

function maximum(valeurs: (number | null)[]): number | null {
  const connues = valeurs.filter((v): v is number => v !== null);
  return connues.length ? Math.max(...connues) : null;
}

export default function AnalyseSession() {
  const { id } = useParams<{ id: string }>();
  const [source, setSource] = useState<"auto" | "live" | "sd">("auto");
  const [donnees, setDonnees] = useState<Colonnes | null>(null);
  const [message, setMessage] = useState("");
  const [codesVus, setCodesVus] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((sessions: Session[]) => {
        const s = sessions.find((x) => String(x.id) === id);
        setCodesVus(s?.defauts_vus ? s.defauts_vus.split(",") : []);
      })
      .catch(() => {});
  }, [id]);

  const charger = useCallback(
    () =>
      fetch(`/api/sessions/${id}/mesures?source=${source}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then(setDonnees)
        .catch((e) => setMessage(e === 404 ? "Session introuvable" : "Serveur injoignable")),
    [id, source],
  );

  useEffect(() => {
    charger();
  }, [charger]);

  const importer = async (fichier: File) => {
    setMessage("Import en cours…");
    const reponse = await fetch(`/api/sessions/${id}/sd`, { method: "POST", body: await fichier.text() });
    const corps = await reponse.json();
    setMessage(reponse.ok ? `${corps.importees} lignes importées depuis ${fichier.name}` : corps.detail);
    setSource("auto");
    charger();
  };

  const [moteur, voiture, electrique] = useMemo(() => {
    if (!donnees) return [null, null, null];
    const t = donnees.t_ms.map((x) => x / 1000);
    return [
      [t, donnees.regime, donnees.papillon, donnees.charge],
      [t, donnees.vitesse, donnees.temp],
      [t, donnees.tension.map((v) => (v === null ? null : v / 10)), donnees.voyant],
    ] as uPlot.AlignedData[];
  }, [donnees]);
  const aDesDonneesElectriques = donnees?.tension.some((v) => v !== null) || donnees?.voyant.some((v) => v !== null);

  const n = donnees?.t_ms.length ?? 0;
  const stats = donnees && n > 0 && [
    { nom: "Durée", valeur: duree((donnees.t_ms[n - 1] - donnees.t_ms[0]) / 1000) },
    { nom: "Régime max", valeur: `${maximum(donnees.regime) ?? "—"} tr/min` },
    { nom: "Vitesse max", valeur: `${maximum(donnees.vitesse) ?? "—"} km/h` },
    { nom: "Température max", valeur: `${maximum(donnees.temp) ?? "—"} °C` },
    { nom: "Mesures", valeur: `${n} (${donnees.source === "sd" ? "journal SD" : "live"})` },
  ];

  return (
    <>
      <div className="entete">
        <h1><Link href="/sessions">Sessions</Link> · {id}</h1>
        <div className="actions">
          <select className="bouton" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="auto">Meilleure source</option>
            <option value="sd">Journal SD</option>
            <option value="live">Live</option>
          </select>
          <label className="bouton">
            Importer le journal SD
            <input type="file" accept=".csv,.CSV" hidden onChange={(e) => e.target.files?.[0] && importer(e.target.files[0])} />
          </label>
          <a className="bouton" href={`/api/sessions/${id}/export.csv?source=${source}`}>Exporter en CSV</a>
          <Link className="bouton" href={`/journal?session=${id}`}>Journal</Link>
        </div>
      </div>
      {message && <p className="message">{message}</p>}

      {stats && (
        <div className="tuiles">
          {stats.map((s) => (
            <div className="tuile" key={s.nom}>
              <div className="nom">{s.nom}</div>
              <div className="detail" style={{ fontSize: 20, color: "var(--texte)" }}>{s.valeur}</div>
            </div>
          ))}
        </div>
      )}
      {codesVus.length > 0 && (
        <>
          <h2>Codes défaut apparus pendant la session</h2>
          <ul className="codes">
            {codesVus.map((c) => <li key={c}><b>{c}</b>{descriptionCode(c)}</li>)}
          </ul>
        </>
      )}
      {donnees && n === 0 && <p className="vide">Aucune mesure {source === "sd" ? "SD" : "live"} pour cette session.</p>}

      {moteur && voiture && n > 0 && (
        <>
          <h2>Moteur · glisser pour zoomer, double-clic pour revenir</h2>
          <Graphique key={`m-${donnees!.source}`} series={SERIES_MOTEUR} donnees={moteur} hauteur={300} />
          <h2>Voiture</h2>
          <Graphique key={`v-${donnees!.source}`} series={SERIES_VOITURE} donnees={voiture} />
          {aDesDonneesElectriques && electrique && (
            <>
              <h2>Électrique et voyant moteur</h2>
              <Graphique key={`e-${donnees!.source}`} series={SERIES_ELECTRIQUE} donnees={electrique} hauteur={180} />
            </>
          )}
        </>
      )}
    </>
  );
}
