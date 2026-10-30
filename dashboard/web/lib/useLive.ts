"use client";

import { useEffect, useRef, useState } from "react";
import { urlLive, type Evenement, type Mesure } from "./telemetrie";

// Connexion au flux live du serveur, avec reconnexion automatique.
// `surMesure` reçoit chaque mesure (pour garder un historique) ; la dernière est renvoyée.
// `surEvenement` reçoit chaque nouvelle ligne du journal.
export function useLive(surMesure?: (m: Mesure) => void, surEvenement?: (e: Evenement) => void) {
  const [serveur, setServeur] = useState(false); // navigateur ↔ serveur
  const [boitier, setBoitier] = useState(false); // R4 ↔ serveur
  const [derniere, setDerniere] = useState<Mesure | null>(null);
  const [codes, setCodes] = useState<string[]>([]); // codes défaut actuels de la voiture
  const [recueLe, setRecueLe] = useState(0);
  const [maintenant, setMaintenant] = useState(Date.now());
  const rappel = useRef(surMesure);
  rappel.current = surMesure;
  const rappelEvenement = useRef(surEvenement);
  rappelEvenement.current = surEvenement;

  useEffect(() => {
    let ws: WebSocket;
    let arrete = false;
    let relance = 0;
    const ouvrir = () => {
      ws = new WebSocket(urlLive());
      ws.onopen = () => setServeur(true);
      ws.onclose = () => {
        setServeur(false);
        if (!arrete) relance = window.setTimeout(ouvrir, 2000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "boitier") setBoitier(msg.connecte);
        if (msg.type === "defauts") setCodes(msg.codes);
        if (msg.type === "evenement") rappelEvenement.current?.(msg);
        if (msg.type !== "mesure") return;
        rappel.current?.(msg);
        setDerniere(msg);
        setRecueLe(Date.now());
      };
    };
    ouvrir();
    const horloge = window.setInterval(() => setMaintenant(Date.now()), 250);
    return () => {
      arrete = true;
      clearTimeout(relance);
      clearInterval(horloge);
      ws.close();
    };
  }, []);

  const silence = recueLe ? Math.max(0, maintenant - recueLe) / 1000 : null;
  return { serveur, boitier, derniere, setDerniere, silence, codes };
}
