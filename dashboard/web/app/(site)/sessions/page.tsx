"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { dateHeure, duree, type Session } from "@/lib/telemetrie";

export default function Sessions() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [erreur, setErreur] = useState("");

  const charger = () =>
    fetch("/api/sessions")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setSessions)
      .catch(() => setErreur("Serveur injoignable"));

  useEffect(() => {
    charger();
  }, []);

  const supprimer = async (s: Session) => {
    if (!confirm(`Supprimer la session ${s.id} et toutes ses mesures ?`)) return;
    await fetch(`/api/sessions/${s.id}`, { method: "DELETE" });
    charger();
  };

  return (
    <>
      <h1>Sessions</h1>
      <p className="message">
        Une session commence à chaque démarrage de la R4. Importez le fichier SESSxxx.CSV de la carte SD
        pour remplacer le live (incomplet) par le journal complet.
      </p>
      {erreur && <p className="alerte">{erreur}</p>}
      {sessions?.length === 0 && <p className="vide">Aucune session enregistrée pour l&apos;instant.</p>}
      {!!sessions?.length && (
        <div className="tableau">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Début</th>
                <th className="nombre">Durée</th>
                <th className="nombre">Trames live</th>
                <th className="nombre">Perdues</th>
                <th>Codes défaut</th>
                <th>Journal SD</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const total = s.nb_live + s.trames_perdues;
                return (
                  <tr key={s.id}>
                    <td><Link href={`/sessions/${s.id}`}>{s.id}</Link></td>
                    <td>{dateHeure(s.debut)}</td>
                    <td className="nombre">{duree(s.fin - s.debut)}</td>
                    <td className="nombre">{s.nb_live}</td>
                    <td className="nombre">
                      {s.trames_perdues} {total > 0 && <span className="message">({((s.trames_perdues / total) * 100).toFixed(1)} %)</span>}
                    </td>
                    <td>{s.defauts_vus ? <span className="attention mono-court">{s.defauts_vus.split(",").join(" ")}</span> : <span className="message">aucun</span>}</td>
                    <td>{s.nb_sd ? <span className="ok">importé</span> : <span className="message">non</span>}</td>
                    <td className="actions">
                      <Link className="bouton" href={`/sessions/${s.id}`}>Analyser</Link>
                      <a className="bouton" href={`/api/sessions/${s.id}/export.csv`}>CSV</a>
                      <button className="bouton danger" onClick={() => supprimer(s)}>Supprimer</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
