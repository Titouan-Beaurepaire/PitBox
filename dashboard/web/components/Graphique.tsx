"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";

export type Serie = { label: string; couleur: string; axe: "gauche" | "droite"; unite: string };

type Props = {
  series: Serie[];
  donnees: uPlot.AlignedData; // [temps en s, série 1, série 2, ...]
  hauteur?: number;
};

const AXE = { stroke: "#8b93a7", grid: { stroke: "#1d222c" }, ticks: { stroke: "#1d222c" } };

// Courbes sur un axe de temps en secondes, avec un axe à gauche et un axe à droite
export default function Graphique({ series, donnees, hauteur = 260 }: Props) {
  const conteneur = useRef<HTMLDivElement>(null);
  const graphique = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = conteneur.current!;
    const unite = (axe: Serie["axe"]) => series.find((s) => s.axe === axe)?.unite ?? "";
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: hauteur,
      scales: { x: { time: false } },
      series: [
        { label: "t (s)", value: (_, v) => (v == null ? "—" : v.toFixed(1)) },
        ...series.map((s) => ({ label: s.label, stroke: s.couleur, width: 2, scale: s.axe, spanGaps: false })),
      ],
      axes: [
        { ...AXE, values: (_, v) => v.map((x) => `${x} s`) },
        { ...AXE, scale: "gauche", label: unite("gauche"), size: 60 },
        ...(series.some((s) => s.axe === "droite") ? [{ ...AXE, scale: "droite", side: 1, label: unite("droite"), size: 50 }] : []),
      ],
      legend: { live: true },
      cursor: { drag: { x: true, y: false } },
    };
    graphique.current = new uPlot(opts, donnees, el);
    const observateur = new ResizeObserver(() => graphique.current?.setSize({ width: el.clientWidth, height: hauteur }));
    observateur.observe(el);
    return () => {
      observateur.disconnect();
      graphique.current?.destroy();
      graphique.current = null;
    };
    // les séries ne changent pas pendant la vie du composant
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    graphique.current?.setData(donnees);
  }, [donnees]);

  return <div ref={conteneur} className="graphique" />;
}
