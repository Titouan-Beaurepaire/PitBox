"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { descriptionCode } from "@/lib/codes";
import { type Evenement } from "@/lib/telemetrie";
import { useLive } from "@/lib/useLive";

const PAGE = 200;

const NIVEAUX = [
  { nom: "Tout", valeur: "" },
  { nom: "Attention et alertes", valeur: "attention,alerte" },
  { nom: "Alertes", valeur: "alerte" },
];
const SOURCES = [
  { nom: "Tout", valeur: "" },
  { nom: "Voiture", valeur: "voiture" },
  { nom: "R4", valeur: "r4" },
  { nom: "Serveur", valeur: "serveur" },
];

type Sauvegarde = { nom: string; taille: number; date: number };

function heure(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
}

function Journal() {
  const session = useSearchParams().get("session");
  const [niveau, setNiveau] = useState("");
  const [source, setSource] = useState("");
  const [evenements, setEvenements] = useState<Evenement[] | null>(null);
  const [nouveaux, setNouveaux] = useState<Set<number>>(new Set());
  const [encore, setEncore] = useState(false);
  const [erreur, setErreur] = useState("");
  const [sauvegarde, setSauvegarde] = useState<Sauvegarde | null>(null);

  const charger = useCallback(
    (avant?: number) => {
      const params = new URLSearchParams({ limite: String(PAGE), niveau, source });
      if (session) params.set("session", session);
      if (avant) params.set("avant", String(avant));
      fetch(`/api/journal?${params}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
        .then((page: Evenement[]) => {
          setEvenements((avant ? (liste: Evenement[] | null) => [...(liste ?? []), ...page] : () => page));
          setEncore(page.length === PAGE);
          setErreur("");
        })
        .catch(() => setErreur("Serveur injoignable"));
    },
    [niveau, source, session],
  );

  useEffect(() => charger(), [charger]);

  useEffect(() => {
    fetch("/api/sauvegardes")
      .then((r) => r.json())
      .then((liste: Sauvegarde[]) => setSauvegarde(liste[0] ?? null))
      .catch(() => {});
  }, []);

  // Les nouveaux événements arrivent en direct, s'ils passent les filtres
  const { serveur } = useLive(undefined, (e) => {
    if (niveau && !niveau.split(",").includes(e.niveau)) return;
    if (source && e.source !== source) return;
    if (session && String(e.session_id) !== session) return;
    setEvenements((liste) => (liste && !liste.some((x) => x.id === e.id) ? [e, ...liste] : liste));
    setNouveaux((ids) => new Set(ids).add(e.id));
    if (e.code === "SAUVEGARDE") fetch("/api/sauvegardes").then((r) => r.json()).then((l) => setSauvegarde(l[0] ?? null));
  });

  return (
    <>
      <div className="entete">
        <h1>{session ? <><Link href="/journal">Journal</Link> · session {session}</> : "Journal"}</h1>
        <div className="statuts">
          <span className={`pastille ${serveur ? "ok" : "alerte"}`}>{serveur ? "En direct" : "Hors ligne"}</span>
          <span className={`pastille ${sauvegarde ? "ok" : "attention"}`}>
            {sauvegarde ? `Sauvegarde : ${heure(sauvegarde.date)}` : "Aucune sauvegarde"}
          </span>
        </div>
      </div>
      <p className="message">
        Tout ce qui s&apos;est passé : la R4 (démarrage, WiFi, CAN, carte SD), la voiture (voyant, codes défaut,
        température, batterie) et le serveur (connexions, sessions, sauvegardes).
      </p>

      <div className="filtres">
        <div className="groupe">
          {NIVEAUX.map((n) => (
            <button key={n.nom} className={niveau === n.valeur ? "actif" : ""} onClick={() => setNiveau(n.valeur)}>{n.nom}</button>
          ))}
        </div>
        <div className="groupe">
          {SOURCES.map((s) => (
            <button key={s.nom} className={source === s.valeur ? "actif" : ""} onClick={() => setSource(s.valeur)}>{s.nom}</button>
          ))}
        </div>
      </div>

      {erreur && <p className="alerte">{erreur}</p>}
      {evenements?.length === 0 && <p className="vide">Rien à afficher pour l&apos;instant.</p>}
      {!!evenements?.length && (
        <div className="tableau">
          <table className="journal">
            <thead>
              <tr>
                <th />
                <th>Heure</th>
                <th>Source</th>
                <th>Événement</th>
                <th>Détail</th>
                <th className="nombre">Session</th>
              </tr>
            </thead>
            <tbody>
              {evenements.map((e) => (
                <tr key={e.id} className={nouveaux.has(e.id) ? "nouveau" : ""}>
                  <td className={`niveau ${e.niveau}`} title={e.niveau} />
                  <td className="heure">{heure(e.t)}</td>
                  <td className="source">{e.source}</td>
                  <td className={`code ${e.niveau === "info" ? "" : e.niveau}`}>{e.code}</td>
                  <td>
                    {e.message}
                    {e.code.startsWith("CODE_") && <span className="message"> — {descriptionCode(e.message)}</span>}
                  </td>
                  <td className="nombre">
                    {e.session_id !== null && <Link href={`/sessions/${e.session_id}`}>{e.session_id}</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {encore && evenements && (
        <p><button className="bouton" onClick={() => charger(evenements[evenements.length - 1].id)}>Plus ancien</button></p>
      )}
    </>
  );
}

export default function PageJournal() {
  return (
    <Suspense>
      <Journal />
    </Suspense>
  );
}
